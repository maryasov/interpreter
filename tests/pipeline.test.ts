import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocSession } from '../src/engine/index.ts';
import { runPipeline, extractJsonArray } from '../src/agent/pipeline.ts';
import { Session } from '../src/agent/session.ts';
import { MockProvider, type ChatMessage, type ChatResult } from '../src/agent/provider.ts';

const source = readFileSync(new URL('../samples/example-readme.md', import.meta.url), 'utf8');

const DICT: Record<string, string> = {
  'Example Plugin': 'Пример плагина',
  'A minimal plugin that shows what the marketplace README looks like.':
    'Минимальный плагин, показывающий, как выглядит README маркетплейса.',
  Commands: 'Команды',
  Command: 'Команда',
  Description: 'Описание',
  Example: 'Пример',
  'Greets the user in the current locale': 'Приветствует пользователя на текущей локали',
  'Pulls the latest catalog snapshot': 'Загружает последний снимок каталога',
  'Searches plugins by name or tag': 'Ищет плагины по имени или тегу',
  Notes: 'Примечания',
  'Install with ': 'Установка: ',
  'Works offline after the first sync.': 'Работает офлайн после первой синхронизации.',
};

/** Model that reads the unit list out of the prompt and returns a JSON array. */
function jsonArrayProvider(): MockProvider {
  return new MockProvider((_step, messages: ChatMessage[]): ChatResult => {
    const user = [...messages].reverse().find((m) => m.role === 'user');
    const rows: { address: string; text: string }[] = [];
    for (const line of (user?.content ?? '').split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const u = JSON.parse(t) as { address: string; text: string };
        if (DICT[u.text]) rows.push({ address: u.address, text: DICT[u.text] });
      } catch { /* ignore non-JSON prose lines */ }
    }
    return { message: { role: 'assistant', content: JSON.stringify(rows) }, usage: { prompt_tokens: 15, completion_tokens: 8 } };
  });
}

function newJob(id: string): { job: Session; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'interp-pipe-'));
  const job = new Session(dir, id, { source: 'en', target: 'ru', mode: 'pipeline', unitsTotal: 0 });
  return { job, dir };
}

test('extractJsonArray tolerates prose and code fences', () => {
  assert.deepEqual(extractJsonArray('here you go:\n```json\n[{"a":1}]\n```\nhope that helps'), [{ a: 1 }]);
  assert.deepEqual(extractJsonArray('no array here'), []);
});

test('pipeline mode translates the doc and preserves the table layout', async () => {
  const doc = new DocSession(source, 'ru');
  const { job, dir } = newJob('pipe-1');
  const res = await runPipeline({ provider: jsonArrayProvider(), doc, job, system: 'sys', batchSize: 4 });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(res.ok, true, res.error ?? 'ok');
  const md = res.markdown!;
  assert.ok(md.includes('Команда'));
  assert.ok(md.includes('Приветствует пользователя'));
  assert.ok(md.includes('`/hello`'), 'inline code preserved');
  assert.ok(md.includes('export const greet'), 'code fence preserved');
  assert.equal((md.match(/\|/g) ?? []).length, (source.match(/\|/g) ?? []).length);
  assert.equal(job.status.state, 'succeeded');
});
