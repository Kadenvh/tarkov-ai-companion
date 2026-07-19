/**
 * Scheduled TarkovTracker read feed (SPEC-8, the "read-mostly mirror" strategy).
 *
 * A tiny, injectable, stoppable poller: when a token is configured the service
 * pulls `GET /progress` on startup and every N minutes, funnelling each read
 * through the ONE sync path (M10 `progress-read` source → the change-aware
 * `ProfileStore.importTarkovTracker`). It never writes — TarkovMonitor owns the
 * write path (research/02 §4/§6), and the shared 100/day write budget must not
 * be double-spent.
 *
 * Resilience: `sync()` is expected to resolve to a best-effort result (it never
 * throws — TarkovTracker down/unconfigured/quota-exhausted is a no-op, not a
 * crash), but any stray rejection is caught and routed to `onError` so a single
 * failed poll never tears down the interval. Timers are injectable (tests drive
 * ticks deterministically) and unref'd (a pending poll never keeps the process
 * alive at shutdown).
 */

export interface TrackerSyncSchedulerOptions {
  /** Poll period in ms. Must be > 0 (the runtime gates a 0/absent interval). */
  intervalMs: number;
  /** The best-effort sync to run each tick (and, unless disabled, on start). */
  sync: () => Promise<unknown>;
  /** Run one sync immediately on `start()` (default true). */
  syncOnStart?: boolean;
  /** Observe a rejected sync (default: swallow). */
  onError?: (err: unknown) => void;
  /** Injectable interval timer (tests). Defaults to the global `setInterval`. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** Injectable clear (tests). Defaults to the global `clearInterval`. */
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export class TrackerSyncScheduler {
  private handle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  constructor(private readonly opts: TrackerSyncSchedulerOptions) {
    this.setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h));
  }

  /** Idempotent. Kicks an optional startup sync, then schedules the interval. */
  start(): void {
    if (this.handle !== null) return;
    if (this.opts.syncOnStart !== false) void this.runOnce();
    this.handle = this.setIntervalFn(() => {
      void this.runOnce();
    }, this.opts.intervalMs);
    // Never keep the event loop alive for a pending poll (Node timer only).
    (this.handle as { unref?: () => void }).unref?.();
  }

  /** Idempotent. Stops the interval; an in-flight poll is allowed to settle. */
  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  /**
   * Run one sync now (also the interval body, and directly callable by tests).
   * Coalesces: a tick that fires while a poll is still in flight is dropped
   * rather than stacking reads against the shared quota. Never throws.
   */
  async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.opts.sync();
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.inFlight = false;
    }
  }
}
