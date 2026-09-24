/**
 * Pipeline mode: deterministic batch translation without the tool loop.
 *
 * For the common case (README/description translation at marketplace scale) a
 * full agent conversation is overkill and costly. Here we chunk the pending
 * units, ask the model for a JSON array of {address,text} per chunk, keep only
 * the edits that pass the engine gate, and assemble. Structural safety is the
 * same as agent mode — invalid rows are simply not committed.
 */
import type { DocSession } from '../engine/index.ts';
import { langName } from '../engine/md.ts';
import type { Provider, ChatMessage } from './provider.ts';
import { Session } from './session.ts';

export interface PipelineOptions {
  provider: Provider;
  doc: DocSession;
  job: Session;
  system: string;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  ok: boolean;
  markdown?: string;
  error?: string;
}

export async function runPipeline(opts: PipelineOptions): Promise<RunResult> {
  const { provider, doc, job } = opts;
  const size = opts.batchSize ?? 20;
  job.setState('running');

  const units = doc.translatableUnits();
  for (let i = 0; i < units.length; i += size) {
    if (opts.signal?.aborted) { job.setState('cancelled'); return { ok: false, error: 'cancelled' }; }
    const chunk = units.slice(i, i + size);
    const ask: ChatMessage[] = [
      { role: 'system', content: opts.system },
      {
        role: 'user',
        content:
          `Translate each unit into ${langName(doc.target)}. Respond with ONLY a JSON array of ` +
          `{"address": string, "text": string}. Text is plain — never add | \` [ ] or leading #/> markup; ` +
          `keep it identical if it must not be translated.\nUnits:\n` +
          chunk.map((u) => JSON.stringify({ address: u.address, text: u.text, where: u.context.cell ? `cell r${u.context.cell.row}c${u.context.cell.col}` : u.context.container })).join('\n'),
      },
    ];
    let res;
    try {
      res = await provider.chat(ask, [], { signal: opts.signal, toolChoice: 'none' });
    } catch (err) {
      job.setState('failed', { lastError: String(err) });
      return { ok: false, error: String(err) };
    }
    job.addCost({ promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens });
    const rows = extractJsonArray(res.message.content ?? '');
    let applied = 0;
    for (const row of rows) {
      if (typeof row.address !== 'string' || typeof row.text !== 'string') continue;
      if (doc.translate(row.address, row.text).ok) applied++;
      else job.addProgress({ rejected: job.status.progress.rejected + 1 });
    }
    job.addProgress({ translated: doc.editedCount(), skipped: doc.skippedCount() });
    job.emit('batch', { from: i, applied, returned: rows.length });
  }

  // Skip anything the model left untouched, then gate the whole document.
  for (const u of doc.translatableUnits()) if (doc.isPending(u.address)) doc.skip(u.address);
  const fin = doc.finish();
  if (!fin.ok) { job.setState('failed', { lastError: fin.error ?? undefined }); return { ok: false, error: fin.error ?? undefined }; }
  job.writeResult(fin.markdown!);
  job.setState('succeeded');
  return { ok: true, markdown: fin.markdown };
}

/** Pull the first JSON array out of a model reply (tolerant of prose fences). */
export function extractJsonArray(text: string): Record<string, unknown>[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
  } catch {
    return [];
  }
}
