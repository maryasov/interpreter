/**
 * Provider abstraction over an OpenAI-compatible chat-completions endpoint
 * (with tool/function calling). Kept tiny and dependency-free (global fetch).
 *
 * The agent loop only needs `chat()`; a `MockProvider` implements the same
 * interface so the whole harness is testable offline and the model can be
 * swapped by editing config/env (baseURL/model/key) — any OpenAI-compatible
 * chat-completions endpoint works.
 */

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage: Usage;
}

export interface ChatOptions {
  temperature?: number;
  toolChoice?: 'auto' | 'none' | { name: string };
  signal?: AbortSignal;
}

export interface Provider {
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolSpec[], opts?: ChatOptions): Promise<ChatResult>;
}

export interface OpenAIConfig {
  baseURL: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  /** Extra headers (auth style gateways). */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class OpenAIProvider implements Provider {
  readonly model: string;
  constructor(private cfg: OpenAIConfig) {
    this.model = cfg.model;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], opts: ChatOptions = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature ?? 0,
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = opts.toolChoice ?? 'auto';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 120_000);
    if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort());
    try {
      const res = await fetch(`${this.cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
          ...this.cfg.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const json = (await res.json()) as {
        choices: { message: ChatMessage }[];
        usage?: Partial<Usage>;
      };
      const message = json.choices?.[0]?.message ?? { role: 'assistant', content: null };
      return {
        message: normalizeMessage(message),
        usage: { prompt_tokens: json.usage?.prompt_tokens ?? 0, completion_tokens: json.usage?.completion_tokens ?? 0 },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeMessage(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { role: m.role ?? 'assistant', content: typeof m.content === 'string' ? m.content : null };
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
  return out;
}

/** Scripted provider for tests and offline dry-runs. */
export class MockProvider implements Provider {
  readonly model = 'mock';
  calls: ChatMessage[][] = [];
  constructor(private script: (step: number, messages: ChatMessage[]) => ChatResult) {}
  async chat(messages: ChatMessage[], _tools: ToolSpec[], _opts?: ChatOptions): Promise<ChatResult> {
    this.calls.push(messages);
    return this.script(this.calls.length - 1, messages);
  }
}

/** Build a tool-call message from a list of {name,args} — used by MockProvider. */
export function toolCallMessage(calls: { name: string; args: object }[]): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: calls.map((c, i) => ({
      id: `call_${i}`,
      type: 'function' as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  };
}
