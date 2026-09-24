import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobServer } from '../src/server/http.ts';
import { loadConfig, type AppConfig } from '../src/agent/config.ts';
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

function pipelineProvider(): MockProvider {
  return new MockProvider((_step, messages: ChatMessage[]): ChatResult => {
    const user = [...messages].reverse().find((m) => m.role === 'user');
    const rows: { address: string; text: string }[] = [];
    for (const line of (user?.content ?? '').split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const u = JSON.parse(t) as { address: string; text: string };
        if (DICT[u.text]) rows.push({ address: u.address, text: DICT[u.text] });
      } catch { /* skip prose */ }
    }
    return { message: { role: 'assistant', content: JSON.stringify(rows) }, usage: { prompt_tokens: 12, completion_tokens: 6 } };
  });
}

function testConfig(overrides: Partial<AppConfig['server']> = {}): { config: AppConfig; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'interp-srv-'));
  const config = structuredClone(loadConfig('/nonexistent.toml', {}));
  config.server = { ...config.server, host: '127.0.0.1', port: 0, jobDir: dir, ...overrides };
  return { config, dir };
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() < deadline);
  return last!;
}

test('HTTP job API: submit → poll → result (async interface for other agents)', async () => {
  const { config, dir } = testConfig();
  const handle = await createJobServer({ config, provider: pipelineProvider() });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const health = await fetch(`${base}/healthz`).then((r) => r.json());
    assert.equal(health.ok, true);

    const submit = await fetch(`${base}/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: source, target: 'ru', mode: 'pipeline' }),
    });
    assert.equal(submit.status, 202);
    const { job_id: id } = (await submit.json()) as { job_id: string };
    assert.ok(id);

    const final = await waitFor(
      () => fetch(`${base}/jobs/${id}`).then((r) => r.json()) as Promise<{ state: string }>,
      (s) => s.state === 'succeeded' || s.state === 'failed',
    );
    assert.equal(final.state, 'succeeded', JSON.stringify(final));

    const md = await fetch(`${base}/jobs/${id}/result`).then((r) => r.text());
    assert.ok(md.includes('Команда'));
    assert.ok(md.includes('`/hello`'), 'markup preserved end-to-end');
    assert.equal((md.match(/\|/g) ?? []).length, (source.match(/\|/g) ?? []).length);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP job API: bearer token guards endpoints', async () => {
  const { config, dir } = testConfig({ token: 'secret' });
  const handle = await createJobServer({ config, provider: pipelineProvider() });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const denied = await fetch(`${base}/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: source, target: 'ru', mode: 'pipeline' }),
    });
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ text: source, target: 'ru', mode: 'pipeline' }),
    });
    assert.equal(allowed.status, 202);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP job API: unknown job is 404', async () => {
  const { config, dir } = testConfig();
  const handle = await createJobServer({ config, provider: pipelineProvider() });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/jobs/does-not-exist`);
    assert.equal(res.status, 404);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
