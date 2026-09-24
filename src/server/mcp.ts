/**
 * MCP server (stdio, newline-delimited JSON-RPC 2.0, no SDK). Lets any
 * MCP-capable agent drive translations in two modes:
 *
 *   - translate_markdown {text,target,...}   synchronous, for small documents
 *   - start_job / job_status / job_result     async job API (A2A-style status)
 *
 * The tool payloads mirror the HTTP API so a caller can move between them.
 */
import { createInterface } from 'node:readline';
import { loadConfig, type AppConfig } from '../agent/config.ts';
import type { Provider } from '../agent/provider.ts';
import { translate } from '../translate.ts';
import { JobRegistry } from './jobs.ts';

const PROTOCOL = '2024-11-05';

interface RpcMessage { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }

const TOOLS = [
  {
    name: 'translate_markdown',
    description: 'Translate a markdown document preserving structure (tables/code/links untouched). Returns the translated markdown.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, target: { type: 'string' }, source: { type: 'string' }, mode: { enum: ['agent', 'pipeline'] } },
      required: ['text', 'target'],
    },
  },
  {
    name: 'start_job',
    description: 'Start an async translation job; returns a job_id to poll.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, target: { type: 'string' }, source: { type: 'string' }, mode: { enum: ['agent', 'pipeline'] } }, required: ['text', 'target'] },
  },
  { name: 'job_status', description: 'Get an job state/progress/cost by job_id.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
  { name: 'job_result', description: 'Get the finished markdown for a job_id (error if not ready).', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
];

export function serveMcp(config: AppConfig = loadConfig(), provider?: Provider): void {
  const registry = new JobRegistry(config);
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcMessage;
    try { msg = JSON.parse(trimmed); } catch { return; }
    const reply = await dispatch(msg, config, registry, provider);
    if (reply && msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n');
  });
}

async function dispatch(msg: RpcMessage, config: AppConfig, registry: JobRegistry, provider?: Provider): Promise<Partial<RpcMessage> | null> {
  switch (msg.method) {
    case 'initialize':
      return { result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'interpreter-translator', version: '0.1.0' } } };
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return { result: { tools: TOOLS } };
    case 'tools/call':
      return { result: await callTool((msg.params as { name: string; arguments: Record<string, unknown> }), config, registry, provider) };
    case 'ping':
      return { result: {} };
    default:
      return { error: { code: -32601, message: `unknown method ${msg.method}` } };
  }
}

async function callTool(params: { name: string; arguments: Record<string, unknown> }, config: AppConfig, registry: JobRegistry, provider?: Provider): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const a = params.arguments ?? {};
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] });
  try {
    switch (params.name) {
      case 'translate_markdown': {
        const res = await translate({ text: String(a.text), target: String(a.target), source: a.source as string | undefined, mode: a.mode as 'agent' | 'pipeline' | undefined, config, provider });
        return res.ok ? text(res.markdown) : { content: [{ type: 'text', text: `failed: ${res.error}` }], isError: true };
      }
      case 'start_job': {
        const managed = registry.submit({ text: String(a.text), target: String(a.target), source: a.source as string | undefined, mode: a.mode as 'agent' | 'pipeline' | undefined, provider });
        return text(JSON.stringify({ job_id: managed.id, state: managed.job.status.state }));
      }
      case 'job_status': {
        const st = registry.status(String(a.job_id));
        return st ? text(JSON.stringify(st)) : { content: [{ type: 'text', text: 'no such job' }], isError: true };
      }
      case 'job_result': {
        const md = registry.result(String(a.job_id));
        return md !== undefined ? text(md) : { content: [{ type: 'text', text: 'not ready' }], isError: true };
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool ${params.name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: String(err) }], isError: true };
  }
}
