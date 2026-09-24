import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocSession } from '../src/engine/index.ts';
import { runAgent } from '../src/agent/loop.ts';
import { Session } from '../src/agent/session.ts';
import { MockProvider, toolCallMessage, type ChatResult } from '../src/agent/provider.ts';

const source = readFileSync(new URL('../samples/example-readme.md', import.meta.url), 'utf8');

// English → Russian dictionary for the fixture's prose units.
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

function newJob(id: string): { job: Session; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'interp-agent-'));
  const job = new Session(dir, id, { source: 'en', target: 'ru', mode: 'agent', unitsTotal: 0 });
  return { job, dir };
}

test('agent loop translates a table-bearing doc via tools and passes the gate', async () => {
  const doc = new DocSession(source, 'ru');
  const { job, dir } = newJob('agent-1');

  // Scripted model: list → one batch of every translatable unit → finish.
  const provider = new MockProvider((step): ChatResult => {
    if (step === 0) return { message: toolCallMessage([{ name: 'list_units', args: {} }]), usage: { prompt_tokens: 10, completion_tokens: 2 } };
    if (step === 1) {
      const rows = doc.translatableUnits()
        .filter((u) => DICT[u.text])
        .map((u) => ({ address: u.address, text: DICT[u.text] }));
      return { message: toolCallMessage([{ name: 'batch_translate', args: { rows } }]), usage: { prompt_tokens: 20, completion_tokens: 5 } };
    }
    return { message: toolCallMessage([{ name: 'finish', args: {} }]), usage: { prompt_tokens: 5, completion_tokens: 1 } };
  });

  const res = await runAgent({ provider, doc, job, system: 'sys', maxTurns: 10 });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(res.ok, true, res.error ?? 'ok');
  const md = res.markdown!;
  assert.ok(md.includes('Команда'), 'header cell translated');
  assert.ok(md.includes('Приветствует пользователя'), 'body cell translated');
  assert.ok(md.includes('`/hello`'), 'inline code preserved');
  assert.ok(md.includes('npm i example-plugin'), 'inline code in list preserved');
  assert.ok(md.includes('export const greet'), 'code fence preserved');
  assert.ok(md.includes('name: example-plugin'), 'frontmatter preserved');
  // table layout byte-preserved: same pipe count
  assert.equal((md.match(/\|/g) ?? []).length, (source.match(/\|/g) ?? []).length);
  assert.equal(job.status.state, 'succeeded');
});

test('agent rejects a batch that would break structure and still finishes', async () => {
  const doc = new DocSession(source, 'ru');
  const { job, dir } = newJob('agent-2');
  const cell = doc.units().find((u) => u.text === 'Greets the user in the current locale')!;

  const provider = new MockProvider((step): ChatResult => {
    if (step === 0) {
      // one bad row (injects a pipe) → atomic batch rejected
      return { message: toolCallMessage([{ name: 'batch_translate', args: { rows: [{ address: cell.address, text: 'привет | мир' }] } }]), usage: { prompt_tokens: 5, completion_tokens: 1 } };
    }
    if (step === 1) {
      // model reacts: translate all valid units instead
      const rows = doc.translatableUnits().filter((u) => DICT[u.text]).map((u) => ({ address: u.address, text: DICT[u.text] }));
      return { message: toolCallMessage([{ name: 'batch_translate', args: { rows } }]), usage: { prompt_tokens: 8, completion_tokens: 3 } };
    }
    return { message: toolCallMessage([{ name: 'finish', args: {} }]), usage: { prompt_tokens: 2, completion_tokens: 1 } };
  });

  const res = await runAgent({ provider, doc, job, system: 'sys', maxTurns: 10 });
  const rejected = job.events().some((e) => e.kind === 'tool' && (e.data as { name?: string }).name === 'batch_translate');
  rmSync(dir, { recursive: true, force: true });

  assert.ok(rejected, 'batch tool was exercised');
  assert.equal(res.ok, true, res.error ?? 'ok');
});

test('agent turns a budget failure into a failed job', async () => {
  const doc = new DocSession(source, 'ru');
  const { job, dir } = newJob('agent-3');
  // Model that never calls finish.
  const provider = new MockProvider((): ChatResult => ({
    message: toolCallMessage([{ name: 'progress', args: {} }]),
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
  const res = await runAgent({ provider, doc, job, system: 'sys', maxTurns: 3 });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(res.ok, false);
  assert.match(res.error!, /turn budget/);
  assert.equal(job.status.state, 'failed');
});
