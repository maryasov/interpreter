/**
 * HTTP job API — the interface for *other agents* to run and observe a
 * translation. A2A-style lifecycle: submit → poll → fetch result; SSE for a
 * live event feed; cancel for control. Bearer-token guarded when configured.
 *
 *   POST /jobs                 { text | file_b64, target, source?, mode? } → { job_id, state }
 *   GET  /jobs/:id             → JobStatus (state, progress, cost, last_error?)
 *   GET  /jobs/:id/result      → translated markdown (text/markdown)
 *   GET  /jobs/:id/events      → SSE transcript stream
 *   POST /jobs/:id/cancel      → { cancelled: bool }
 *   GET  /healthz              → { ok, model }
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '../agent/config.ts';
import type { Provider } from '../agent/provider.ts';
import { JobRegistry } from './jobs.ts';

export interface ServerHandle {
  server: ReturnType<typeof createServer>;
  registry: JobRegistry;
  port: number;
  close(): Promise<void>;
}

export interface CreateOptions {
  config?: AppConfig;
  provider?: Provider;      // injectable for tests
}

export async function createJobServer(opts: CreateOptions = {}): Promise<ServerHandle> {
  const config = opts.config ?? loadConfig();
  const registry = new JobRegistry(config);

  const server = createServer((req, res) => {
    handle(req, res, config, registry, opts.provider).catch((err) => json(res, 500, { error: String(err) }));
  });

  await new Promise<void>((resolve) => server.listen(config.server.port, config.server.host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    registry,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, config: AppConfig, registry: JobRegistry, provider?: Provider): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/healthz') return json(res, 200, { ok: true, model: config.providers[config.activeProvider]?.model });
  if (!authorize(req, config)) return json(res, 401, { error: 'unauthorized' });

  if (path === '/jobs' && req.method === 'POST') {
    const body = (await readBody(req)) as { text?: string; file_b64?: string; target: string; source?: string; mode?: 'agent' | 'pipeline'; jobId?: string };
    const text = body.text ?? (body.file_b64 ? Buffer.from(body.file_b64, 'base64').toString('utf8') : undefined);
    if (!text || !body.target) return json(res, 400, { error: 'need text (or file_b64) and target' });
    const jobId = body.jobId ?? randomUUID().slice(0, 8);
    const managed = registry.submit({ text, target: body.target, source: body.source, mode: body.mode, jobId, provider });
    return json(res, 202, { job_id: jobId, state: managed.job.status.state, status_url: `/jobs/${jobId}` });
  }

  const jobMatch = /^\/jobs\/([^/]+)(\/(result|events|cancel))?$/.exec(path);
  if (jobMatch) {
    const id = decodeURIComponent(jobMatch[1]);
    const sub = jobMatch[3];
    const status = registry.status(id);
    if (!status) return json(res, 404, { error: 'no such job' });
    if (!sub) return json(res, 200, status);
    if (sub === 'result' && req.method === 'GET') {
      const md = registry.result(id);
      if (md === undefined) return json(res, 409, { error: 'not ready', state: status.state });
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return void res.end(md);
    }
    if (sub === 'events' && req.method === 'GET') return sse(res, registry, id);
    if (sub === 'cancel' && req.method === 'POST') return json(res, 200, { cancelled: registry.cancel(id) });
  }
  return json(res, 404, { error: 'not found' });
}

function sse(res: ServerResponse, registry: JobRegistry, id: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const managed = registry.get(id);
  const send = (evt: unknown) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  const job = managed?.job;
  if (job) for (const e of job.events()) send(e);
  let last = job?.events().length ?? 0;
  const timer = setInterval(() => {
    if (!job) return clearInterval(timer);
    const events = job.events();
    for (let i = last; i < events.length; i++) send(events[i]);
    last = events.length;
    const st = job.status.state;
    if (st === 'succeeded' || st === 'failed' || st === 'cancelled') {
      send({ kind: 'final', status: job.status });
      clearInterval(timer);
      res.end();
    }
  }, 500);
  req_close(res, () => clearInterval(timer));
}

function req_close(res: ServerResponse, fn: () => void): void {
  res.on('close', fn);
}

function authorize(req: IncomingMessage, config: AppConfig): boolean {
  if (!config.server.token) return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${config.server.token}`;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8_000_000) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}
