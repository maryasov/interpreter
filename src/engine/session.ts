/**
 * DocSession — the stateful translation workspace (no LLM here).
 *
 * Holds the original source plus a map of accepted unit edits. Because every
 * edit stores the *original* byte range of its unit, assembly splices them
 * into the source from last to first, so edits never interfere and untouched
 * bytes (all markup, code, frontmatter, URLs) stay byte-for-byte identical.
 *
 * Each proposed edit is validated structurally before it can be accepted: the
 * enclosing block is re-parsed and its *shape* (node-type + geometry, text
 * content ignored) must be unchanged. That is what makes "translate one table
 * cell" safe and rejects the rare inputs where translated text would itself
 * introduce markup (a stray `|`, backtick, or `**`).
 */
import type { Document, Unit } from './addresses.ts';
import { buildDocument } from './addresses.ts';
import {
  parseDoc, structureSignature, urlSignatures, codeSpanSignatures,
  looksLikeLang, langName, UNTRANSLATABLE_BLOCK, offsetOf,
} from './md.ts';

export interface EditResult {
  ok: boolean;
  error?: string;
}

export class DocSession {
  readonly doc: Document;
  private edits = new Map<string, string>();   // address → replacement text
  private skipped = new Set<string>();          // address → left as-is
  private byAddress: Map<string, Unit>;

  constructor(readonly source: string, readonly target: string) {
    this.doc = buildDocument(source);
    this.byAddress = new Map(this.doc.units.map((u) => [u.address, u]));
  }

  units(): Unit[] {
    return this.doc.units;
  }

  translatableUnits(): Unit[] {
    return this.doc.units.filter((u) => u.translatable);
  }

  get(address: string): Unit | undefined {
    return this.byAddress.get(address);
  }

  editedCount(): number {
    return this.edits.size;
  }

  skippedCount(): number {
    return this.skipped.size;
  }

  /** True while a translatable unit has neither an accepted edit nor a skip. */
  isPending(address: string): boolean {
    const u = this.get(address);
    return !!u && u.translatable && !this.edits.has(address) && !this.skipped.has(address);
  }

  pendingCount(): number {
    return this.translatableUnits().filter((u) => this.isPending(u.address)).length;
  }

  /** Raw source slice of a block (for translator context). */
  blockRaw(blockId: number): string | undefined {
    return this.doc.blocks.find((b) => b.id === blockId)?.raw;
  }

  skip(address: string): EditResult {
    const u = this.get(address);
    if (!u) return { ok: false, error: `unknown address ${address}` };
    if (this.edits.has(address)) return { ok: false, error: `${address} already translated` };
    this.skipped.add(address);
    return { ok: true };
  }

  /**
   * Dry-run: validate a candidate translation for a unit without committing.
   * Returns an error string, or null when the edit would be accepted.
   */
  canTranslate(address: string, newText: string): string | null {
    const u = this.get(address);
    if (!u) return `unknown address ${address}`;
    if (!u.translatable) return `${address} is protected (${u.kind}) — it cannot be translated`;
    if (newText.trim() === '') return 'empty translation';
    if (newText === u.text) return 'translation equals source — translate it or use skip_unit';
    return this.validateOne(u, newText, this.target);
  }

  /** Validate then commit a single unit translation. */
  translate(address: string, newText: string): EditResult {
    const err = this.canTranslate(address, newText);
    if (err) return { ok: false, error: err };
    this.edits.set(address, newText);
    this.skipped.delete(address);
    return { ok: true };
  }

  /**
   * Structural validation of a single edit against its enclosing block. The
   * block is re-parsed with the candidate text and its *shape* (node-type +
   * geometry, text ignored) must be unchanged. Returns an error string or null.
   */
  private validateOne(u: Unit, value: string, target: string): string | null {
    const block = this.doc.blocks.find((b) => b.id === u.blockId)!;
    const before = parseDoc(block.raw).children[0];
    const relStart = u.start - block.start;
    const relEnd = u.end - block.start;
    const editedBlock = block.raw.slice(0, relStart) + value + block.raw.slice(relEnd);
    const after = parseDoc(editedBlock).children[0];
    if (!after) return 'result does not parse as markdown';
    if (structureSignature(before) !== structureSignature(after)) {
      return 'structure changed (markup would be introduced) — do not add | ` [ ] or leading #/>/list markers to plain text';
    }
    if (urlSignatures(block.raw).join('') !== urlSignatures(editedBlock).join('')) return 'links changed';
    if (codeSpanSignatures(block.raw).join('') !== codeSpanSignatures(editedBlock).join('')) return 'inline code changed';
    // Soft language gate: only when the unit carries enough letters to judge.
    if (/[A-Za-z\u0410-\u044f\u0430-\u044f\u4e00-\u9fff]{3,}/.test(u.text) && !looksLikeLang(value, target)) {
      return `output does not look like ${langName(target)}`;
    }
    return null;
  }

  /** Assemble the final markdown from the original + accepted edits. */
  assemble(): string {
    const splices = [...this.edits.entries()].map(([addr, text]) => {
      const u = this.get(addr)!;
      return { start: u.start, end: u.end, text };
    }).sort((a, b) => b.start - a.start);
    let out = this.source;
    for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);
    return out;
  }

  /** Finish: assemble + whole-document integrity gate. */
  finish(): { ok: boolean; markdown?: string; error?: string; stats: FinishStats } {
    const out = this.assemble();
    const stats: FinishStats = {
      units: this.translatableUnits().length,
      translated: this.edits.size,
      skipped: this.skipped.size,
      untouched: this.translatableUnits().length - this.edits.size - this.skipped.size,
    };
    const err = validateDocumentIntegrity(this.source, out, this.target);
    if (err) return { ok: false, error: err, stats };
    return { ok: true, markdown: out, stats };
  }
}

export interface FinishStats {
  units: number;
  translated: number;
  skipped: number;
  untouched: number;
}

/**
 * Post-hoc integrity gate for an assembled translation (a structural QC check
 * adapted to unit-surgery output). Every invariant that must hold: identical
 * block-type sequence, byte-equal protected blocks, identical URLs / inline
 * code / table geometry, plausible target language.
 */
export function validateDocumentIntegrity(source: string, translated: string, target: string): string | null {
  const srcBlocks = docBlockSignatures(source);
  const dstBlocks = docBlockSignatures(translated);
  if (srcBlocks.types.join(',') !== dstBlocks.types.join(',')) return 'block structure differs from source';

  for (let i = 0; i < srcBlocks.protected.length; i++) {
    if (srcBlocks.protected[i] !== dstBlocks.protected[i]) return `protected block ${i} (code/html) was altered`;
  }
  if (urlSignatures(source).join('') !== urlSignatures(translated).join('')) return 'links changed';
  if (codeSpanSignatures(source).join('') !== codeSpanSignatures(translated).join('')) return 'inline code changed';
  if (srcBlocks.tableGeometry.join(';') !== dstBlocks.tableGeometry.join(';')) return 'table geometry changed';

  const ratio = translated.length / Math.max(1, source.length);
  if (ratio < 0.2 || ratio > 3) return `implausible length ratio ${ratio.toFixed(2)}`;
  if (!looksLikeLang(stripProtected(translated), target)) return `output does not look like ${langName(target)}`;
  return null;
}

function docBlockSignatures(text: string): { types: string[]; protected: string[]; tableGeometry: string[] } {
  const tree = parseDoc(text);
  const types: string[] = [];
  const prot: string[] = [];
  const geom: string[] = [];
  for (const c of tree.children) {
    types.push(c.type);
    if (UNTRANSLATABLE_BLOCK.has(c.type)) {
      const off = offsetOf(c);
      prot.push(off ? text.slice(off.start, off.end) : '');
    }
    if (c.type === 'table') {
      geom.push((c as { children: { children: unknown[] }[] }).children.map((r) => r.children.length).join('x'));
    }
  }
  return { types, protected: prot, tableGeometry: geom };
}

function stripProtected(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/^---[\s\S]*?---\n/, ' ');
}
