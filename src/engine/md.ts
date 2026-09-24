/**
 * Low-level markdown structure helpers shared by the engine.
 *
 * Design (see ../architecture.md): we never re-generate markdown. We parse to
 * mdast (remark), address the *text leaves*, and translate by replacing only a
 * text node's exact source range in the original bytes. Inline code, link URLs,
 * emphasis markers, table pipes and everything outside a text node are, by
 * construction, never part of an editable range. Structural validation after
 * each edit is the safety net that catches the few ways plain text can still
 * change layout (a stray `|`, `` ` ``, `[`, leading `#`, …).
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, Node } from 'mdast';

export const parser = unified().use(remarkParse).use(remarkGfm);

export function parseDoc(text: string): Root {
  return parser.parse(text) as Root;
}

/** Byte length of a leading `--- … ---` frontmatter fence (0 if absent). */
export function frontmatterLength(text: string): number {
  if (!text.startsWith('---\n')) return 0;
  const end = text.indexOf('\n---', 4);
  return end === -1 ? 0 : text.indexOf('\n', end + 1) + 1;
}

/** mdast node types whose text is never offered for translation. */
export const UNTRANSLATABLE_BLOCK = new Set([
  'code', 'html', 'yaml', 'toml', 'math', 'definition', 'thematicBreak', 'mdxjsEsm',
]);

export function langRatio(text: string, re: RegExp): number {
  const matches = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? [];
  const chars = matches.join('').length;
  return text.length === 0 ? 0 : chars / text.length;
}

const SCRIPTS: Record<string, { test: (t: string) => boolean; name: string }> = {
  ru: { test: (t) => langRatio(t, /[а-яё]/i) >= 0.15, name: 'Russian' },
  zh: { test: (t) => langRatio(t, /[\u4e00-\u9fff]/) >= 0.05, name: 'Chinese' },
  en: { test: (t) => langRatio(t, /[\u4e00-\u9fffа-яё]/i) <= 0.1, name: 'English' },
};

/** Does `text` plausibly read as the `target` language (cheap heuristic). */
export function looksLikeLang(text: string, target: string): boolean {
  const s = SCRIPTS[target];
  return s ? s.test(text) : true;
}

export function langName(code: string): string {
  return SCRIPTS[code]?.name ?? code;
}

/** All link/image destinations, sorted — must survive byte-equal. */
export function urlSignatures(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)[^)]*\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/<(https?:\/\/[^>\s]+)>/g)) found.push(m[1]);
  for (const m of text.matchAll(/(?:src|href)="([^"]+)"/g)) found.push(m[1]);
  return found.sort();
}

/** Inline code spans — must survive byte-identical. */
export function codeSpanSignatures(text: string): string[] {
  return (text.match(/`[^`\n]+`/g) ?? []).sort();
}

/** Structural fingerprint of a subtree: node-type multiset + table geometry. */
export function structureSignature(node: Node | RootContent): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    const x = n as { type?: string; depth?: number; ordered?: boolean; align?: unknown; children?: unknown[] };
    if (!x || typeof x !== 'object') return;
    if (x.type) {
      let tag = x.type;
      if (x.type === 'heading') tag += `:${x.depth}`;
      if (x.type === 'list') tag += `:${x.ordered ? 'o' : 'u'}:${x.children?.length ?? 0}`;
      if (x.type === 'table') tag += `:${x.children?.length ?? 0}`;
      if (x.type === 'tableRow') tag += `:${x.children?.length ?? 0}`;
      parts.push(tag);
    }
    for (const c of x.children ?? []) walk(c);
  };
  walk(node);
  return parts.join(',');
}

export interface Offset {
  start: number;
  end: number;
}

/** A source range with the byte offsets, guarding against missing positions. */
export function offsetOf(node: { position?: Node['position'] }): Offset | null {
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  return s === undefined || e === undefined ? null : { start: s, end: e };
}
