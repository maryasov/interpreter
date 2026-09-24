#!/usr/bin/env node
/**
 * Offline demo — runs the whole engine + agent on the sample README with a
 * scripted MockProvider, so you can see structure-aware translation without any
 * network or API key. Real runs use `cli.ts translate …` against the gateway.
 *
 *   node --experimental-transform-types src/demo.ts
 */
import { readFileSync } from 'node:fs';
import { DocSession } from './engine/index.ts';
import { runPipeline } from './agent/pipeline.ts';
import { Session } from './agent/session.ts';
import { MockProvider, type ChatMessage, type ChatResult } from './agent/provider.ts';

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

const source = readFileSync(new URL('../samples/example-readme.md', import.meta.url), 'utf8');
const doc = new DocSession(source, 'ru');

console.log('== unit map (address · translatable · context · text) ==');
for (const u of doc.units()) {
  const ctx = u.context.cell ? `cell r${u.context.cell.row}c${u.context.cell.col}` : u.context.container;
  console.log(`${u.address.padEnd(10)} ${u.translatable ? '  ' : '🔒'} ${ctx.padEnd(18)} ${JSON.stringify(u.text)}`);
}

const provider = new MockProvider((_step, messages: ChatMessage[]): ChatResult => {
  const user = [...messages].reverse().find((m) => m.role === 'user');
  const rows: { address: string; text: string }[] = [];
  for (const line of (user?.content ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const u = JSON.parse(t) as { address: string; text: string };
      if (DICT[u.text]) rows.push({ address: u.address, text: DICT[u.text] });
    } catch { /* skip */ }
  }
  return { message: { role: 'assistant', content: JSON.stringify(rows) }, usage: { prompt_tokens: 0, completion_tokens: 0 } };
});

const job = new Session('.interpreter/demo', 'demo', { source: 'en', target: 'ru', mode: 'pipeline', unitsTotal: 0 });
const res = await runPipeline({ provider, doc, job, system: '(demo)', batchSize: 20 });

console.log('\n== translated markdown ==');
console.log(res.ok ? res.markdown : `(failed: ${res.error})`);
