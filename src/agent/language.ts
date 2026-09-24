/**
 * Source-language detection (script-share heuristic). Kept separate so both
 * the loop summary and the HTTP/MCP layers can auto-fill `source` when a caller
 * omits it.
 */
import { langRatio } from '../engine/md.ts';

export function detectSource(text: string): string {
  const sample = text.slice(0, 4000);
  if (langRatio(sample, /[\u4e00-\u9fff]/) >= 0.08) return 'zh';
  if (langRatio(sample, /[а-яё]/i) >= 0.12) return 'ru';
  return 'en';
}

const NAMES: Record<string, string> = { en: 'English', ru: 'Russian', zh: 'Chinese', uk: 'Ukrainian', de: 'German', fr: 'French', es: 'Spanish', ja: 'Japanese', ko: 'Korean' };
export function langName(code: string): string {
  return NAMES[code] ?? code;
}
