/**
 * High-level translation entrypoint shared by the CLI, HTTP job API and MCP
 * server. Wires config → provider → (system prompt + skills) → DocSession →
 * agent-or-pipeline, and hands back the finished markdown plus the job status.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DocSession } from './engine/index.ts';
import { loadConfig, type AppConfig } from './agent/config.ts';
import { OpenAIProvider, type Provider } from './agent/provider.ts';
import { loadSkills, selectSkills, renderSkills } from './agent/skills.ts';
import { Session } from './agent/session.ts';
import { runAgent } from './agent/loop.ts';
import { runPipeline } from './agent/pipeline.ts';
import { detectSource } from './agent/language.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export interface TranslateRequest {
  text: string;
  target: string;
  source?: string;
  mode?: 'agent' | 'pipeline';
  jobId?: string;
  provider?: Provider;      // injectable (tests / alternate gateways)
  config?: AppConfig;
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface TranslateResponse {
  ok: boolean;
  markdown?: string;
  error?: string;
  status: Session['status'];
  job: Session;
}

export function buildSystemPrompt(doc: DocSession, config: AppConfig, skillsDir = HERE + '../skills'): string {
  let base = 'You are a precise technical translator working on markdown documents. ' +
    'Translate natural-language text only. Never translate code, commands, identifiers, ' +
    'URLs or inline code — leave them byte-identical. Preserve the exact meaning, tone and ' +
    'terminology. You operate through tools on discrete text units; you cannot and must not ' +
    'emit whole documents.';
  const promptFile = config.agent.systemPromptFile;
  if (promptFile && existsSync(promptFile)) base = readFileSync(promptFile, 'utf8').trim();

  const skills = selectSkills(loadSkills(skillsDir), doc.source + ' ' + doc.target);
  return base + renderSkills(skills);
}

export function makeProvider(config: AppConfig): Provider {
  const conf = config.providers[config.activeProvider] ?? config.providers.default;
  if (!conf.baseURL || !conf.model) {
    throw new Error('LLM provider not configured — set LLM_BASE_URL and LLM_MODEL (copy .env.example to .env, or fill [providers.*] in config.toml).');
  }
  return new OpenAIProvider(conf);
}

export async function translate(req: TranslateRequest): Promise<TranslateResponse> {
  const started = startTranslate(req);
  const result = await started.promise;
  return { ...result, status: started.job.status, job: started.job };
}

/**
 * Start a translation without awaiting it: returns the live Session (for
 * polling status) and the completion promise. This is what the HTTP job API
 * and MCP server use so a caller gets a job id immediately.
 */
export function startTranslate(req: TranslateRequest): { job: Session; promise: Promise<{ ok: boolean; markdown?: string; error?: string }> } {
  const config = req.config ?? loadConfig();
  const provider = req.provider ?? makeProvider(config);
  const target = req.target;
  const source = req.source ?? detectSource(req.text);
  const mode = req.mode ?? config.agent.mode;

  const doc = new DocSession(req.text, target);
  const job = new Session(config.server.jobDir, req.jobId ?? `job-${Date.now().toString(36)}`, {
    source, target, mode, unitsTotal: doc.translatableUnits().length,
  });
  const system = buildSystemPrompt(doc, config);

  const promise = (mode === 'pipeline'
    ? runPipeline({ provider, doc, job, system, signal: req.signal })
    : runAgent({ provider, doc, job, system, maxTurns: req.maxTurns ?? config.agent.maxTurns, signal: req.signal })
  ).then((r) => ({ ok: r.ok, markdown: r.markdown, error: r.error }));

  // Never let a background job reject unhandled.
  promise.catch(() => {});
  return { job, promise };
}
