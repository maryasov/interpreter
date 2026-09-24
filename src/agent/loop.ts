/**
 * The agent loop — the whole harness. observe → tool → observe until the model
 * calls finish/abort or the turn budget runs out.
 *
 * Deliberately small (the research finding: thin harnesses win). It owns only:
 * message assembly, tool dispatch, a turn budget, cost/progress accounting and
 * the transcript. All translation *correctness* lives in the engine's gates, so
 * a misbehaving model can request but never commit a layout-breaking edit.
 */
import type { DocSession } from '../engine/index.ts';
import { langName } from '../engine/index.ts';
import type { Provider, ChatMessage } from './provider.ts';
import { TranslatorTools, type ToolResult } from './tools.ts';
import { Session } from './session.ts';
import { detectSource } from './language.ts';

export interface AgentOptions {
  provider: Provider;
  doc: DocSession;
  job: Session;
  system: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  ok: boolean;
  markdown?: string;
  error?: string;
}

export async function runAgent(opts: AgentOptions): Promise<RunResult> {
  const { provider, doc, job, system } = opts;
  const maxTurns = opts.maxTurns ?? 40;
  const tools = new TranslatorTools(doc);
  const specs = tools.specs();

  const summary = summarize(doc);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content:
        `Translate this document into ${langName(doc.target)}. It has been decomposed into addressable text ` +
        `units; markup, code, frontmatter and link URLs are protected and cannot be edited. ` +
        `Workflow: call list_units, then translate_unit or batch_translate every unit (skip_unit for content ` +
        `that must stay verbatim), and finally finish. ${summary}`,
    },
  ];
  job.setState('running');

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal?.aborted) {
      job.setState('cancelled', { lastError: 'aborted' });
      return { ok: false, error: 'cancelled' };
    }
    let res;
    try {
      res = await provider.chat(messages, specs, { signal: opts.signal });
    } catch (err) {
      job.setState('failed', { lastError: String(err) });
      return { ok: false, error: String(err) };
    }
    job.addCost({ promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens });
    messages.push(res.message);

    const calls = res.message.tool_calls ?? [];
    if (!calls.length) {
      // Some models answer in prose; nudge them back to the tool protocol.
      messages.push({ role: 'user', content: 'Please continue using the tools (list_units → translate → finish).' });
      continue;
    }

    let terminal: ToolResult | undefined;
    for (const call of calls) {
      const args = safeParse(call.function.arguments);
      let out: ToolResult;
      try {
        out = tools.run(call.function.name, args);
      } catch (err) {
        out = { content: JSON.stringify({ ok: false, error: `tool error: ${(err as Error).message}` }) };
      }
      job.emit('tool', { turn, name: call.function.name, args, result: out.content.slice(0, 2000) });
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: out.content });
      if (out.terminate) terminal = out;
    }
    job.addProgress({ translated: doc.editedCount(), skipped: doc.skippedCount(), rejected: pendingRejected(doc) });

    if (terminal) {
      if (terminal.ok && terminal.markdown) {
        job.writeResult(terminal.markdown);
        job.setState('succeeded', { lastError: undefined });
        return { ok: true, markdown: terminal.markdown };
      }
      job.setState('failed', { lastError: terminal.error });
      return { ok: false, error: terminal.error };
    }
  }

  job.setState('failed', { lastError: 'turn budget exhausted' });
  return { ok: false, error: 'turn budget exhausted' };
}

function summarize(doc: DocSession): string {
  const units = doc.translatableUnits();
  const byKind: Record<string, number> = {};
  for (const u of units) {
    const k = u.context.cell ? 'table cell' : u.context.container;
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  const parts = Object.entries(byKind).map(([k, n]) => `${n} ${k}`);
  const src = detectSource(doc.source);
  return `There are ${units.length} translatable units (${parts.join(', ')}). Detected source language: ${src}.`;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

function pendingRejected(_doc: DocSession): number {
  return 0; // rejection accounting is per-tool-call in Transcript; kept for API shape
}
