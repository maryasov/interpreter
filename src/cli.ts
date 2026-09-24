#!/usr/bin/env node
/**
 * Command-line entrypoint.
 *
 *   translate <file> --to <lang> [--from <lang>] [--mode agent|pipeline]
 *             [--out <file>] [--config <toml>] [--max-turns N]
 *   status <jobId> [--config <toml>]      read a job's state from disk
 *   serve [--config <toml>]               run the HTTP job API
 *   mcp  [--config <toml>]                run the MCP (stdio) server
 *
 * Thin by design — every real path goes through the same translate()/server
 * modules the HTTP and MCP interfaces use, so behaviour is identical regardless
 * of who drives the agent (human or another agent).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from './agent/config.ts';
import { translate } from './translate.ts';
import { JobRegistry } from './server/jobs.ts';
import { createJobServer } from './server/http.ts';
import { serveMcp } from './server/mcp.ts';

interface Flags { [k: string]: string | boolean }

function parseFlags(argv: string[]): { _: string[]; flags: Flags } {
  const _: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

async function main(): Promise<void> {
  const { _, flags } = parseFlags(process.argv.slice(2));
  const cmd = _[0] ?? 'help';
  const config = loadConfig(str(flags.config));

  switch (cmd) {
    case 'translate': {
      const file = _[1];
      const target = str(flags.to);
      if (!file || !target) return usage('translate needs <file> and --to <lang>');
      const text = readFileSync(file, 'utf8');
      const res = await translate({
        text,
        target,
        source: str(flags.from),
        mode: str(flags.mode) as 'agent' | 'pipeline' | undefined,
        maxTurns: flags['max-turns'] ? Number(flags['max-turns']) : undefined,
        config,
      });
      if (!res.ok) {
        process.stderr.write(`FAILED (${res.status.state}): ${res.error ?? 'unknown error'}\n`);
        process.exitCode = 1;
        return;
      }
      const out = res.markdown ?? '';
      if (flags.out) { writeFileSync(String(flags.out), out); process.stderr.write(`wrote ${String(flags.out)}\n`); }
      else process.stdout.write(out.endsWith('\n') ? out : out + '\n');
      process.stderr.write(
        `job ${res.status.id}: ${res.status.state} · ${res.status.progress.translated}/${res.status.progress.unitsTotal} units · ` +
        `tokens ${res.status.cost.promptTokens}+${res.status.cost.completionTokens}\n`,
      );
      return;
    }
    case 'status': {
      const id = _[1];
      if (!id) return usage('status needs <jobId>');
      const st = new JobRegistry(config).status(id);
      if (!st) { process.stderr.write(`no such job: ${id}\n`); process.exitCode = 1; return; }
      process.stdout.write(JSON.stringify(st, null, 2) + '\n');
      return;
    }
    case 'serve': {
      const handle = await createJobServer({ config });
      process.stderr.write(`interpreter job API on http://${config.server.host}:${handle.port} (model ${config.providers[config.activeProvider]?.model})\n`);
      return; // keep process alive
    }
    case 'mcp': {
      serveMcp(config);
      return;
    }
    default:
      return usage(cmd === 'help' ? undefined : `unknown command: ${cmd}`);
  }
}

function usage(err?: string): void {
  const msg = `interpreter — structure-aware markdown translation agent

Usage:
  interpreter translate <file> --to <lang> [--from <lang>] [--mode agent|pipeline]
                        [--out <file>] [--config <toml>] [--max-turns N]
  interpreter status <jobId> [--config <toml>]
  interpreter serve [--config <toml>]
  interpreter mcp   [--config <toml>]
`;
  if (err) { process.stderr.write(err + '\n\n' + msg); process.exitCode = 2; }
  else process.stdout.write(msg);
}

main().catch((err) => { process.stderr.write(`error: ${err instanceof Error ? err.stack : String(err)}\n`); process.exitCode = 1; });
