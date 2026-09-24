import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDocument, DocSession } from '../src/engine/index.ts';

const source = readFileSync(new URL('../samples/example-readme.md', import.meta.url), 'utf8');

test('blocks + text units addressed, protected leaves flagged', () => {
  const doc = buildDocument(source);
  assert.ok(doc.blocks.some((b) => b.type === 'code'));
  assert.ok(doc.blocks.some((b) => b.type === 'table'));
  const code = doc.units.filter((u) => u.kind === 'code');
  assert.ok(code.length >= 1, 'inline code leaves recorded as protected');
  assert.ok(code.every((u) => !u.translatable));
  // frontmatter never becomes a unit
  assert.ok(!doc.units.some((u) => u.text.includes('example-plugin\nversion')));
});

test('table cells carry row/col context; header is row 0', () => {
  const doc = buildDocument(source);
  const cells = doc.units.filter((u) => u.context.cell);
  assert.ok(cells.some((u) => u.text === 'Command' && u.context.cell!.row === 0));
  // GFM: the delimiter row is not a tableRow node, so body rows start at 1.
  assert.ok(cells.some((u) => u.text === 'Greets the user in the current locale' && u.context.cell!.row === 1));
  // delimiter row must contribute no cells
  assert.ok(!cells.some((u) => u.text.includes('---')));
});

test('translate_cell edits only the addressed text, markup byte-intact', () => {
  const s = new DocSession(source, 'ru');
  const cell = s.units().find((u) => u.text === 'Command')!;
  const r = s.translate(cell.address, 'Команда');
  assert.equal(r.error, undefined);
  const out = s.assemble();
  assert.ok(out.includes('| Команда |'));
  assert.ok(out.includes('| Description |')); // neighbour untouched
  // pipes count unchanged → layout preserved
  const pipes = (t: string) => (t.match(/\|/g) ?? []).length;
  assert.equal(pipes(out), pipes(source));
});

test('rejecting structural injection: a pipe in a cell is refused', () => {
  const s = new DocSession(source, 'ru');
  const cell = s.units().find((u) => u.text === 'Greets the user in the current locale')!;
  const r = s.translate(cell.address, 'привет | пока | ещё');
  assert.equal(r.ok, false);
  assert.match(r.error!, /structure changed|do not add/);
});

test('protected inline code cannot be translated', () => {
  const s = new DocSession(source, 'ru');
  const code = s.units().find((u) => u.kind === 'code')!;
  const r = s.translate(code.address, 'что-то');
  assert.equal(r.ok, false);
  assert.match(r.error!, /protected/);
});

test('wrong-language output is refused', () => {
  const s = new DocSession(source, 'ru');
  const cell = s.units().find((u) => u.text === 'Pulls the latest catalog snapshot')!;
  const r = s.translate(cell.address, 'Pulls the newest catalog snapshot');
  assert.equal(r.ok, false);
  assert.match(r.error!, /does not look like Russian/);
});

test('finish assembles a valid whole-document translation', () => {
  const s = new DocSession(source, 'ru');
  const dict: Record<string, string> = {
    Command: 'Команда',
    Description: 'Описание',
    Example: 'Пример',
    'Greets the user in the current locale': 'Приветствует пользователя на текущей локали',
    'Pulls the latest catalog snapshot': 'Загружает последний снимок каталога',
    'Searches plugins by name or tag': 'Ищет плагины по имени или тегу',
    'Example Plugin': 'Пример плагина',
    'A minimal plugin that shows what the marketplace README looks like.':
      'Минимальный плагин, показывающий, как выглядит README маркетплейса.',
    Commands: 'Команды',
    Notes: 'Примечания',
    'Install with ': 'Установка: ',
    '.': '.',
    'Works offline after the first sync.': 'Работает офлайн после первой синхронизации.',
  };
  for (const u of s.translatableUnits()) {
    if (dict[u.text]) s.translate(u.address, dict[u.text]);
    else s.skip(u.address); // code-lexicon like `/hello`, npm i … stays
  }
  const res = s.finish();
  assert.equal(res.error, undefined, res.error ?? 'ok');
  assert.ok(res.markdown!.includes('Команда'));
  assert.ok(res.markdown!.includes('`/hello`'));     // code preserved
  assert.ok(res.markdown!.includes('npm i example-plugin')); // code preserved
  assert.ok(res.stats.translated > 5);
});
