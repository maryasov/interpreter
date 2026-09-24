/**
 * Addressing: flatten an mdast document into addressable *units*.
 *
 * A unit is one text leaf (translatable) or inline-code leaf (protected). The
 * canonical address `b<block>.u<leaf>` is stable across translation edits,
 * because editing a unit replaces only that node's source range and never
 * changes the block/leaf enumeration (structural validation enforces this).
 *
 * Cells, list items, headings and link text are recognised as *context* so the
 * translator sees them, but the editable range is always a single text node —
 * that is what keeps table pipes, emphasis markers and URLs byte-safe.
 */
import type { Node, Parent, Root, RootContent } from 'mdast';
import { parseDoc, offsetOf, frontmatterLength, UNTRANSLATABLE_BLOCK } from './md.ts';

export interface UnitContext {
  blockType: string;                   // paragraph | heading | list | table | blockquote …
  container: string;                   // nearest meaningful ancestor kind
  cell?: { row: number; col: number }; // present when inside a table row/cell (row 0 = header)
  listIndex?: number;                  // index of the enclosing listItem within its list
  emphasis?: boolean;
  strong?: boolean;
  linkHref?: string;                   // URL of an enclosing link (must be preserved)
}

export interface Unit {
  address: string;   // b<block>.u<leaf>
  blockId: number;
  kind: 'text' | 'code';
  translatable: boolean;
  text: string;      // exact source slice
  start: number;
  end: number;
  context: UnitContext;
}

export interface BlockInfo {
  id: number;
  type: string;
  translatable: boolean;
  start: number;
  end: number;
  raw: string;
}

export interface Document {
  source: string;
  frontmatter: number;               // byte length of frontmatter (0 if none)
  blocks: BlockInfo[];
  units: Unit[];
}

interface WalkCtx extends UnitContext {
  ancestors: Node[];
}

/** Build the unit list for a parsed document source string. */
export function buildDocument(source: string): Document {
  const tree = parseDoc(source) as Root;
  const fm = frontmatterLength(source);
  const blocks: BlockInfo[] = [];
  const units: Unit[] = [];

  let blockId = 0;
  for (const child of tree.children) {
    const off = offsetOf(child);
    if (!off) continue;
    // remark has no frontmatter parser: it reads the leading `--- … ---` fence as
    // thematic break + headings. Those bytes are frontmatter, not content, so we
    // keep them aside (re-emitted by assemble) and never offer them for translation.
    if (off.end <= fm) continue;
    const translatable = !UNTRANSLATABLE_BLOCK.has(child.type);
    blocks.push({ id: blockId, type: child.type, translatable, start: off.start, end: off.end, raw: source.slice(off.start, off.end) });
    if (translatable) {
      const state = { leaf: 0 };
      walk(child, { blockType: child.type, container: child.type, ancestors: [] }, source, blockId, units, state);
    }
    blockId++;
  }
  return { source, frontmatter: fm, blocks, units };
}

function walk(
  node: RootContent | Parent,
  ctx: WalkCtx,
  source: string,
  blockId: number,
  units: Unit[],
  state: { leaf: number },
): void {
  const n = node as Node & { type: string };

  if (n.type === 'text' || n.type === 'inlineCode') {
    const off = offsetOf(n);
    if (!off) return;
    const { ancestors: _drop, ...context } = ctx;
    units.push({
      address: `b${blockId}.u${state.leaf++}`,
      blockId,
      kind: n.type === 'inlineCode' ? 'code' : 'text',
      translatable: n.type === 'text',
      text: source.slice(off.start, off.end),
      start: off.start,
      end: off.end,
      context,
    });
    return;
  }

  if (!Array.isArray((n as Parent).children)) return;
  const children = (n as Parent).children as Node[];
  const childCtx = derive(n, ctx);

  for (let i = 0; i < children.length; i++) {
    const c = children[i] as Node & { type: string };
    let next: WalkCtx = { ...childCtx, ancestors: [...ctx.ancestors, n] };
    if (n.type === 'tableRow') {
      const table = ctx.ancestors[ctx.ancestors.length - 1] as Parent | undefined;
      const row = table ? (table.children as Node[]).indexOf(n) : 0;
      if (c.type === 'tableCell') next = { ...next, cell: { row: Math.max(0, row), col: i } };
    }
    if (n.type === 'list' && c.type === 'listItem') next = { ...next, listIndex: i };
    walk(c as RootContent, next, source, blockId, units, state);
  }
}

function derive(n: Node & { type: string; url?: string }, ctx: WalkCtx): WalkCtx {
  const next: WalkCtx = { ...ctx };
  if (n.type === 'emphasis') next.emphasis = true;
  if (n.type === 'strong') next.strong = true;
  if (n.type === 'link') next.linkHref = n.url;
  if (['paragraph', 'heading', 'blockquote', 'listItem'].includes(n.type)) next.container = n.type;
  return next;
}
