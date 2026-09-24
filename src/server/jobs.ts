/**
 * In-memory job registry. startTranslate gives a live Session; we keep it (plus
 * an AbortController and the completion promise) keyed by id so status/result/
 * cancel are all O(1). On restart, completed jobs are still readable from disk
 * (Session persists status.json + result.md), which `hydrate` restores lazily.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../agent/config.ts';
import { startTranslate, type TranslateRequest } from '../translate.ts';
import type { Session, JobStatus } from '../agent/session.ts';

export interface ManagedJob {
  id: string;
  job: Session;
  controller: AbortController;
  done: Promise<{ ok: boolean; markdown?: string; error?: string }>;
  markdown?: string;
}

export class JobRegistry {
  private jobs = new Map<string, ManagedJob>();
  constructor(private config: AppConfig) {}

  submit(req: Omit<TranslateRequest, 'config'> & { config?: AppConfig }): ManagedJob {
    const controller = new AbortController();
    const started = startTranslate({ ...req, config: req.config ?? this.config, signal: controller.signal });
    const managed: ManagedJob = { id: started.job.status.id, job: started.job, controller, done: started.promise };
    this.jobs.set(managed.id, managed);
    started.promise.then((r) => { managed.markdown = r.markdown; }).catch(() => {});
    return managed;
  }

  get(id: string): ManagedJob | undefined {
    return this.jobs.get(id);
  }

  statusFromDisk(id: string): JobStatus | undefined {
    const file = join(this.config.server.jobDir, id, 'status.json');
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as JobStatus;
  }

  result(id: string): string | undefined {
    const mem = this.jobs.get(id);
    if (mem?.markdown) return mem.markdown;
    const file = join(this.config.server.jobDir, id, 'result.md');
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  }

  cancel(id: string): boolean {
    const mem = this.jobs.get(id);
    if (!mem || mem.job.status.state === 'succeeded' || mem.job.status.state === 'failed') return false;
    mem.controller.abort();
    return true;
  }

  status(id: string): JobStatus | undefined {
    return this.jobs.get(id)?.job.status ?? this.statusFromDisk(id);
  }
}
