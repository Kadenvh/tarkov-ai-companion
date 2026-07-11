import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * @tier T1 — polling tail over a file the game keeps open for writing.
 *
 * EFT holds its log files open with shared read/write; on Windows,
 * FileSystemWatcher-style change events are unreliable for appends, so the
 * proven pattern (TarkovMonitor) is a >= 1 s poll of the file size with
 * byte-offset resume. Rotation/truncation (size shrinks) resets to 0.
 * A missing file is tolerated — the poll just keeps waiting for it.
 *
 * Performance budget (SPEC §1): no polling faster than 1 s.
 */

export const MIN_POLL_INTERVAL_MS = 1000;

export interface TailOptions {
  /** clamped to >= 1000 ms */
  intervalMs?: number;
  /** resume from a persisted byte offset */
  fromOffset?: number;
}

export class PollingTail {
  readonly file: string;
  offset: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(file: string, opts: TailOptions = {}) {
    this.file = file;
    this.offset = opts.fromOffset ?? 0;
    this.intervalMs = Math.max(MIN_POLL_INTERVAL_MS, opts.intervalMs ?? MIN_POLL_INTERVAL_MS);
  }

  /**
   * One poll cycle: returns newly appended text (utf8), or null when nothing
   * changed / the file does not exist. Public so tests and the watcher can
   * pump without timers.
   */
  poll(): string | null {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return null; // not created yet, or transiently locked
    }
    if (size < this.offset) this.offset = 0; // rotated / truncated
    if (size === this.offset) return null;

    let fd: number;
    try {
      fd = openSync(this.file, "r"); // game writes with FileShare.ReadWrite — plain read works
    } catch {
      return null;
    }
    try {
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, this.offset);
      this.offset += read;
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }

  start(onData: (chunk: string) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const chunk = this.poll();
      if (chunk !== null && chunk.length > 0) onData(chunk);
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
