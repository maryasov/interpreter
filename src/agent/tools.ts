/**
 * Tool surface for the translation agent.
 *
 * The LLM never sees or emits a whole document — only these structured calls
 * that operate on the open DocSession: list pending units, translate one or
 * many, skip, check progress, then finish (which runs the whole-document
 * integrity gate). Every write is validated by the engine; failures come back
 * as human-readable errors the model is expected to react to.
 */
import { z } from 'zod';
import type { DocSession, Unit } from '../engine/index.ts';
import { langName } from '../engine/index.ts';
import type { ToolSpec } from './provider.ts';

export interface ToolResult {
  content: string;        // JSON sent back to the model
  terminate?: boolean;    // finish/abort stop the loop
  ok?: boolean;           // final gate result (when terminate)
  markdown?: string;
  error?: string;
}

function describe(u: Unit): object {
  return {
    address: u.address,
    text: u.text,
    container: u.context.container,
    ...(u.context.cell ? { cell: `r${u.context.cell.row}c${u.context.cell.col}` } : {}),
    ...(u.context.linkHref ? { keepUrl: u.context.linkHref } : {}),
    ...(u.context.emphasis ? { emphasis: true } : {}),
    ...(u.context.strong ? { strong: true } : {}),
  };
}

export class TranslatorTools {
  private rejected = 0;
  constructor(private session: DocSession) {}

  specs(): ToolSpec[] {
    const num = { type: 'number' };
    return [
      {
        type: 'function',
        function: {
          name: 'list_units',
          description: 'List pending translatable text units (address + source + context). Call first, then translate_unit/batch_translate.',
          parameters: { type: 'object', properties: { block: num, limit: num }, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_unit',
          description: 'Fetch one unit with its enclosing block raw markdown for context.',
          parameters: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'], additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'translate_unit',
          description: 'Translate a single text unit. Only plain text — never add | ` [ ] or leading #/> markup. Rejected edits return a reason.',
          parameters: { type: 'object', properties: { address: { type: 'string' }, text: { type: 'string' } }, required: ['address', 'text'], additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'batch_translate',
          description: 'Translate many units at once. Atomic: if any row fails validation the whole batch is rejected and the failing index reported.',
          parameters: {
            type: 'object',
            properties: {
              rows: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, text: { type: 'string' } }, required: ['address', 'text'] } },
            },
            required: ['rows'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'skip_unit',
          description: 'Leave a unit unchanged (brand names, code-lexicon, already-in-target). Legitimate alternative to translating.',
          parameters: { type: 'object', properties: { address: { type: 'string' }, reason: { type: 'string' } }, required: ['address'], additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'progress',
          description: 'Counts of translated / skipped / still-pending units.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'finish',
          description: 'Assemble the document from accepted edits and run the whole-document integrity gate. Returns the translated markdown or a failure reason.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'abort',
          description: 'Stop without producing a translation, with a reason.',
          parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
        },
      },
    ];
  }

  run(name: string, rawArgs: unknown): ToolResult {
    switch (name) {
      case 'list_units': {
        const a = z.object({ block: z.number().optional(), limit: z.number().optional() }).parse(rawArgs);
        let units = this.session.translatableUnits().filter((u) => this.session.isPending(u.address));
        if (a.block !== undefined) units = units.filter((u) => u.blockId === a.block);
        const total = units.length;
        if (a.limit) units = units.slice(0, a.limit);
        return { content: JSON.stringify({ pending: total, units: units.map(describe) }) };
      }
      case 'get_unit': {
        const a = z.object({ address: z.string() }).parse(rawArgs);
        const u = this.session.get(a.address);
        if (!u) return { content: JSON.stringify({ error: 'unknown address' }) };
        return { content: JSON.stringify({ ...describe(u), block: this.session.blockRaw(u.blockId) }) };
      }
      case 'translate_unit': {
        const a = z.object({ address: z.string(), text: z.string() }).parse(rawArgs);
        const r = this.session.translate(a.address, a.text);
        if (!r.ok) { this.rejected++; return { content: JSON.stringify({ ok: false, error: r.error }) }; }
        return { content: JSON.stringify({ ok: true, ...this.counts() }) };
      }
      case 'batch_translate': {
        const a = z.object({ rows: z.array(z.object({ address: z.string(), text: z.string() })) }).parse(rawArgs);
        // Atomic: dry-run validate every row first; commit only if all pass.
        for (let i = 0; i < a.rows.length; i++) {
          const err = this.session.canTranslate(a.rows[i].address, a.rows[i].text);
          if (err) { this.rejected++; return { content: JSON.stringify({ ok: false, failedIndex: i, error: err }) }; }
        }
        for (const row of a.rows) this.session.translate(row.address, row.text);
        return { content: JSON.stringify({ ok: true, applied: a.rows.length, ...this.counts() }) };
      }
      case 'skip_unit': {
        const a = z.object({ address: z.string(), reason: z.string().optional() }).parse(rawArgs);
        const r = this.session.skip(a.address);
        return { content: JSON.stringify(r.ok ? { ok: true, ...this.counts() } : { ok: false, error: r.error }) };
      }
      case 'progress':
        return { content: JSON.stringify({ ...this.counts(), rejected: this.rejected }) };
      case 'finish': {
        const res = this.session.finish();
        if (!res.ok) return { content: JSON.stringify({ ok: false, error: res.error, stats: res.stats }), terminate: true, ok: false, error: res.error };
        return {
          content: JSON.stringify({ ok: true, stats: res.stats, note: `document translated to ${langName(this.session.target)} and passed integrity gate` }),
          terminate: true, ok: true, markdown: res.markdown,
        };
      }
      case 'abort': {
        const a = z.object({ reason: z.string() }).parse(rawArgs);
        return { content: JSON.stringify({ ok: false, aborted: a.reason }), terminate: true, ok: false, error: a.reason };
      }
      default:
        return { content: JSON.stringify({ error: `unknown tool ${name}` }) };
    }
  }

  private counts() {
    return {
      translated: this.session.editedCount(),
      skipped: this.session.skippedCount(),
      pending: this.session.pendingCount(),
    };
  }
}
