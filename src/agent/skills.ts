/**
 * Skills: markdown prompt-modules loaded into the system prompt.
 *
 * Layout: skills/<name>/SKILL.md with a small frontmatter block
 * (`name`, `description`, optional `when` trigger keywords). Same spirit as
 * Qoder/Claude skills, so files are portable. A skill is appended to the
 * system prompt when `when` is absent or any of its keywords appear in the
 * document/target — keeping the base prompt short (the research finding:
 * minimal harnesses win with terse, on-demand context).
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Skill {
  name: string;
  description: string;
  when: string[];
  body: string;
}

function parseFrontmatter(text: string): { meta: Record<string, string[]>; body: string } {
  const meta: Record<string, string[]> = {};
  if (!text.startsWith('---')) return { meta, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta, body: text };
  const head = text.slice(text.indexOf('\n') + 1, end);
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    meta[m[1].toLowerCase()] = m[2].includes(',') ? m[2].split(',').map((s) => s.trim()).filter(Boolean) : [m[2].trim()];
  }
  return { meta, body: text.slice(end + 4).replace(/^\n/, '') };
}

export function loadSkills(dir: string): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const file = statSync(full).isDirectory() ? join(full, 'SKILL.md') : (entry.endsWith('.md') ? full : null);
    if (!file || !existsSync(file)) continue;
    const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
    skills.push({
      name: meta.name?.[0] ?? entry,
      description: meta.description?.[0] ?? '',
      when: meta.when ?? [],
      body: body.trim(),
    });
  }
  return skills;
}

/** Skills whose trigger matches the haystack (document text + target langs). */
export function selectSkills(skills: Skill[], haystack: string): Skill[] {
  const hay = haystack.toLowerCase();
  return skills.filter((s) => s.when.length === 0 || s.when.some((k) => hay.includes(k.toLowerCase())));
}

/** Render selected skills into a system-prompt section. */
export function renderSkills(skills: Skill[]): string {
  if (!skills.length) return '';
  return '\n\n## Active skills\n' + skills.map((s) => `### ${s.name}\n${s.body}`).join('\n\n');
}
