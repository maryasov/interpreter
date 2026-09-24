/**
 * Session: a job's live state + an append-only JSONL transcript.
 *
 * The state machine mirrors A2A task lifecycle so an *external* agent can
 * start a translation and poll it: queued → running → (input-required) →
 * succeeded | failed | cancelled. Progress and cost are kept as plain fields
 * the HTTP/MCP layers serialize directly. Every event is also appended to
 * <jobDir>/<id>/session.jsonl for audit and post-mortem.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export type JobState = 'queued' | 'running' | 'input-required' | 'succeeded' | 'failed' | 'cancelled';

export interface JobProgress {
  unitsTotal: number;
  translated: number;
  skipped: number;
  rejected: number;
}

export interface JobCost {
  promptTokens: number;
  completionTokens: number;
}

export interface JobStatus {
  id: string;
  state: JobState;
  source: string;
  target: string;
  mode: string;
  progress: JobProgress;
  cost: JobCost;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  question?: string;
}

export class Session {
  readonly dir: string;
  status: JobStatus;
  private transcript: string;

  constructor(jobDir: string, id: string, init: { source: string; target: string; mode: string; unitsTotal: number }) {
    this.dir = join(jobDir, id);
    mkdirSync(this.dir, { recursive: true });
    this.transcript = join(this.dir, 'session.jsonl');
    const now = Date.now();
    this.status = {
      id,
      state: 'queued',
      source: init.source,
      target: init.target,
      mode: init.mode,
      progress: { unitsTotal: init.unitsTotal, translated: 0, skipped: 0, rejected: 0 },
      cost: { promptTokens: 0, completionTokens: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.emit('created', init);
  }

  setState(state: JobState, extra: Partial<JobStatus> = {}): void {
    this.status.state = state;
    Object.assign(this.status, extra);
    this.status.updatedAt = Date.now();
    this.emit('state', { state, ...extra });
    this.persist();
  }

  addProgress(patch: Partial<JobProgress>): void {
    Object.assign(this.status.progress, patch);
    this.status.updatedAt = Date.now();
    this.persist();
  }

  addCost(patch: Partial<JobCost>): void {
    this.status.cost.promptTokens += patch.promptTokens ?? 0;
    this.status.cost.completionTokens += patch.completionTokens ?? 0;
    this.persist();
  }

  emit(kind: string, data: unknown): void {
    appendFileSync(this.transcript, JSON.stringify({ t: Date.now(), kind, data }) + '\n');
  }

  private persist(): void {
    writeJson(join(this.dir, 'status.json'), this.status);
  }

  writeResult(markdown: string): void {
    // Reuse status.json's directory; store the translated document too.
    writeFileSyncSafe(join(this.dir, 'result.md'), markdown);
    this.persist();
  }

  /** Transcript lines (for SSE replay / debugging). */
  events(): { t: number; kind: string; data: unknown }[] {
    if (!existsSync(this.transcript)) return [];
    return readFileSync(this.transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}

function writeJson(path: string, obj: unknown): void {
  writeFileSyncSafe(path, JSON.stringify(obj, null, 2));
}

function writeFileSyncSafe(path: string, data: string): void {
  // write tmp + rename for atomicity so pollers never see a half-written file
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
