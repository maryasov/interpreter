/**
 * Config: a tiny TOML-subset reader (no dependency) plus env overrides.
 *
 * Supports what the agent actually needs: `[section]` / `[section.sub]`
 * headers, `key = "value"` (strings), numbers, booleans, string arrays on one
 * line, and `#` comments. Anything richer should move to JSON, but TOML keeps
 * the hand-editable config friendly.
 */
import { readFileSync, existsSync } from 'node:fs';

export interface ProviderConf {
  baseURL: string;
  model: string;
  apiKey?: string;
  temperature?: number;
}

export interface AppConfig {
  server: { host: string; port: number; token?: string; jobDir: string };
  agent: { maxTurns: number; mode: 'agent' | 'pipeline'; systemPromptFile?: string };
  providers: Record<string, ProviderConf>;
  activeProvider: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  server: { host: '127.0.0.1', port: 4100, jobDir: '.interpreter/jobs' },
  agent: { maxTurns: 40, mode: 'agent' },
  providers: {
    // Provider endpoint/model/key are supplied via config.toml or the environment
    // (LLM_BASE_URL / LLM_MODEL / LLM_API_KEY — see .env.example). No gateway is
    // baked into the published defaults; makeProvider() errors if unset.
    default: { baseURL: '', model: '', temperature: 0 },
  },
  activeProvider: 'default',
};

type Value = string | number | boolean | Value[] | { [k: string]: Value };

/** Parse a TOML-subset string into a nested object. */
export function parseToml(text: string): Record<string, Value> {
  const root: Record<string, Value> = {};
  let scope: Record<string, Value> = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      scope = ensurePath(root, sec[1].trim().split('.'));
      continue;
    }
    const kv = /^([A-Za-z0-9_.\-]+)\s*=\s*(.+)$/.exec(line);
    if (kv) {
      const keys = kv[1].split('.');
      const leaf = ensurePath(scope, keys.slice(0, -1));
      leaf[keys[keys.length - 1]] = parseValue(kv[2].trim());
    }
  }
  return root;
}

function stripComment(line: string): string {
  let out = '';
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      out += c;
      if (c === inStr && line[i - 1] !== '\\') inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c; out += c;
    } else if (c === '#') {
      break;
    } else out += c;
  }
  return out;
}

function ensurePath(obj: Record<string, Value>, path: string[]): Record<string, Value> {
  let cur = obj;
  for (const key of path) {
    const next = cur[key];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) cur = next as Record<string, Value>;
    else { cur[key] = {}; cur = cur[key] as Record<string, Value>; }
  }
  return cur;
}

function parseValue(v: string): Value {
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map(parseValue);
  }
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"');
  if (v === 'true') return true;
  if (v === 'false') return false;
  const num = Number(v);
  if (!Number.isNaN(num)) return num;
  return v;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, inStr: string | null = null, cur = '';
  for (const c of s) {
    if (inStr) { cur += c; if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function str(v: Value | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: Value | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Parse a simple `.env` file (KEY=VALUE, `#` comments, optional quotes). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

/**
 * When called with the real process environment (not an injected test env),
 * fold a local `.env` file in underneath it — real env vars win over the file,
 * so `LLM_API_KEY=… node …` still overrides `.env`. Test callers passing an
 * explicit env object are left untouched.
 */
function envWithDotFile(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env !== process.env) return env;
  const file = env.INTERPRETER_ENV_FILE ?? '.env';
  if (!existsSync(file)) return env;
  return { ...parseDotEnv(readFileSync(file, 'utf8')), ...env };
}

export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = envWithDotFile(env);
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  const file = path ?? e.INTERPRETER_CONFIG ?? 'config.toml';
  if (existsSync(file)) applyToml(cfg, parseToml(readFileSync(file, 'utf8')));

  // env overrides (deployment convenience; secrets stay out of the file)
  const p = cfg.providers[cfg.activeProvider] ?? cfg.providers.default;
  cfg.server.host = e.INTERPRETER_HOST ?? cfg.server.host;
  cfg.server.port = Number(e.INTERPRETER_PORT ?? cfg.server.port);
  cfg.server.token = e.INTERPRETER_TOKEN ?? cfg.server.token;
  p.baseURL = e.LLM_BASE_URL ?? e.INTERPRETER_LLM_BASE_URL ?? p.baseURL;
  p.model = e.LLM_MODEL ?? e.INTERPRETER_LLM_MODEL ?? p.model;
  p.apiKey = e.LLM_API_KEY ?? e.INTERPRETER_LLM_API_KEY ?? p.apiKey;
  return cfg;
}

function applyToml(cfg: AppConfig, t: Record<string, Value>): void {
  const server = t.server as Record<string, Value> | undefined;
  if (server) {
    cfg.server.host = str(server.host) ?? cfg.server.host;
    cfg.server.port = num(server.port) ?? cfg.server.port;
    cfg.server.token = str(server.token) ?? cfg.server.token;
    cfg.server.jobDir = str(server.jobDir) ?? cfg.server.jobDir;
  }
  const agent = t.agent as Record<string, Value> | undefined;
  if (agent) {
    cfg.agent.maxTurns = num(agent.maxTurns) ?? cfg.agent.maxTurns;
    const mode = str(agent.mode);
    if (mode === 'agent' || mode === 'pipeline') cfg.agent.mode = mode;
    cfg.agent.systemPromptFile = str(agent.systemPromptFile) ?? cfg.agent.systemPromptFile;
  }
  const active = str(t.activeProvider);
  if (active) cfg.activeProvider = active;
  const providers = t.providers as Record<string, Value> | undefined;
  if (providers) {
    for (const [name, val] of Object.entries(providers)) {
      const pv = val as Record<string, Value>;
      const existing = cfg.providers[name] ?? { baseURL: '', model: '' };
      cfg.providers[name] = {
        baseURL: str(pv.baseURL) ?? existing.baseURL,
        model: str(pv.model) ?? existing.model,
        apiKey: str(pv.apiKey) ?? existing.apiKey,
        temperature: num(pv.temperature) ?? existing.temperature,
      };
    }
  }
}
