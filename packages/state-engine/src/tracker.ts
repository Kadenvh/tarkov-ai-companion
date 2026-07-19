import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataLocalDir } from "@tac/data-core";
import type { ProfileStore } from "./store.js";

/**
 * TarkovTracker mirror (SPEC M2.7) — the LOCAL store is the source of truth;
 * tarkovtracker.org is an optional outbound mirror plus a one-shot import seed
 * (research/02 §6: local-first, mirror outbound).
 *
 * Resilience contract:
 *  - debounced, batched writes (`POST /progress/tasks` counts as ONE write
 *    against the 100/day free quota)
 *  - progressEpoch guard: pushes queued under an older epoch (prestige reset)
 *    are dropped and reconciled via a fresh `GET /progress` re-read
 *  - 401 → mirror disables itself (token revoked/expired), queue is kept,
 *    local data untouched; timeouts/5xx → exponential backoff, queue kept
 *  - never throws out of the flush path, never mutates local state on failure
 *
 * `fetchImpl` is injectable — tests never hit the network. A real-account
 * round-trip is deferred until a token exists on this machine.
 */

export const TRACKER_BASE_URL = "https://api.tarkovtracker.org/api/v2";

const ConfigFile = z
  .object({
    tarkovTrackerToken: z.string().optional(),
    profiles: z
      .record(z.string(), z.object({ tarkovTrackerToken: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

/** Token lookup: per-profile entry in data/local/config.json, then top-level. */
export function loadTrackerToken(
  profileKey: string,
  configPath: string = join(dataLocalDir(), "config.json"),
): string | null {
  try {
    const parsed = ConfigFile.parse(JSON.parse(readFileSync(configPath, "utf8")));
    return parsed.profiles?.[profileKey]?.tarkovTrackerToken ?? parsed.tarkovTrackerToken ?? null;
  } catch {
    return null;
  }
}

export type TrackerTaskState = "completed" | "failed" | "uncompleted";

export interface TrackerMirrorOptions {
  token?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** debounce before a queued batch flushes (ms, default 3000) */
  debounceMs?: number;
  /** request timeout (ms, default 10000) */
  timeoutMs?: number;
  /** cap on backoff (ms, default 300000) */
  maxBackoffMs?: number;
}

export interface TrackerMirrorStatus {
  enabled: boolean;
  disabledReason: string | null;
  queued: number;
  backoffUntil: number | null;
  lastError: string | null;
}

interface QueuedWrite {
  id: string;
  state: TrackerTaskState;
  epoch: number;
}

export class TarkovTrackerMirror {
  private readonly store: ProfileStore;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly debounceMs: number;
  private readonly timeoutMs: number;
  private readonly maxBackoffMs: number;

  private token: string | null;
  private queue = new Map<string, QueuedWrite>();
  private timer: NodeJS.Timeout | null = null;
  private backoffMs = 0;
  private backoffUntil: number | null = null;
  private disabledReason: string | null = null;
  private lastError: string | null = null;
  private detach: (() => void) | null = null;

  constructor(store: ProfileStore, opts: TrackerMirrorOptions = {}) {
    this.store = store;
    this.token = opts.token !== undefined ? opts.token : loadTrackerToken(store.profileKey);
    this.baseUrl = (opts.baseUrl ?? TRACKER_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.debounceMs = opts.debounceMs ?? 3000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 300_000;
  }

  get status(): TrackerMirrorStatus {
    return {
      enabled: this.token !== null && this.disabledReason === null,
      disabledReason: this.disabledReason,
      queued: this.queue.size,
      backoffUntil: this.backoffUntil,
      lastError: this.lastError,
    };
  }

  /** One-shot seed: GET /progress → store.importTarkovTracker. */
  async importOnce(): Promise<{ ok: boolean; error?: string }> {
    if (!this.token) return { ok: false, error: "no token" };
    try {
      const res = await this.request("GET", "/progress");
      if (!res.ok) {
        if (res.status === 401) this.disabledReason = "401 unauthorized (token revoked/expired?)";
        return { ok: false, error: `HTTP ${res.status}` };
      }
      this.store.importTarkovTracker(await res.json());
      return { ok: true };
    } catch (err) {
      this.lastError = String(err);
      return { ok: false, error: this.lastError };
    }
  }

  /** Subscribe to local quest changes and mirror them (debounced). */
  attach(): void {
    if (this.detach) return;
    const listener = (ev: { taskId: string; status: "started" | "completed" | "failed" }) => {
      if (ev.status === "started") return; // .org has no "started" state
      this.queueTask(ev.taskId, ev.status === "completed" ? "completed" : "failed");
    };
    this.store.events.on("quest.changed", listener);
    this.detach = () => this.store.events.off("quest.changed", listener);
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  queueTask(taskId: string, state: TrackerTaskState): void {
    this.queue.set(taskId, { id: taskId, state, epoch: this.store.progressEpoch });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
    this.timer.unref();
  }

  /**
   * Push the queued batch. Public (and awaitable) for tests and shutdown.
   * Never throws; on any failure the queue is retained (or, on epoch
   * mismatch, dropped and reconciled by re-import — the remote copy of a
   * pre-reset epoch must not be resurrected).
   */
  async flush(now: number = Date.now()): Promise<void> {
    if (this.queue.size === 0 || !this.token || this.disabledReason) return;
    if (this.backoffUntil !== null && now < this.backoffUntil) return;

    // epoch guard: prestige reset while queued → these writes describe a dead epoch
    const epoch = this.store.progressEpoch;
    const stale = [...this.queue.values()].filter((q) => q.epoch !== epoch);
    if (stale.length > 0) {
      for (const q of stale) this.queue.delete(q.id);
      await this.importOnce(); // reconcile from remote instead
      if (this.queue.size === 0) return;
    }

    const batch = [...this.queue.values()].map(({ id, state }) => ({ id, state }));
    try {
      const res = await this.request("POST", "/progress/tasks", batch);
      if (res.ok) {
        for (const { id } of batch) this.queue.delete(id);
        this.backoffMs = 0;
        this.backoffUntil = null;
        this.lastError = null;
        return;
      }
      if (res.status === 401) {
        this.disabledReason = "401 unauthorized (token revoked/expired?)";
        this.lastError = this.disabledReason;
        return; // queue kept; local store untouched
      }
      this.applyBackoff(now, `HTTP ${res.status}`);
    } catch (err) {
      this.applyBackoff(now, String(err));
    }
  }

  private applyBackoff(now: number, error: string): void {
    this.lastError = error;
    this.backoffMs = Math.min(this.backoffMs === 0 ? 5000 : this.backoffMs * 2, this.maxBackoffMs);
    this.backoffUntil = now + this.backoffMs;
  }

  private request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return this.fetchImpl(`${this.baseUrl}${path}`, init);
  }
}
