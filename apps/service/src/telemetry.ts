/**
 * Live system / GPU telemetry pipeline (SPEC "Coach" observability slice).
 *
 * Two collaborators:
 *   • {@link TelemetrySampler} — builds one {@link TelemetrySample}: host CPU%
 *     (from `os.cpus()` deltas, Windows-safe — NOT loadavg, which is always 0 on
 *     Windows) + RAM (from `os.totalmem/freemem`), and — when an NVIDIA GPU is
 *     present — a GPU slice sourced from the M9 NVIDIA connector's `perf-telemetry`
 *     read (we REUSE the connector's injected nvidia-smi runner rather than
 *     reimplementing the CLI). No GPU / a failed read → the `gpu` field is OMITTED
 *     (system-only sample). The sampler NEVER throws.
 *   • {@link TelemetryScheduler} — mirrors {@link TrackerSyncScheduler}: an
 *     injectable, stoppable, unref'd poller that samples on a fixed interval into a
 *     capped in-memory ring buffer and hands each sample to `onSample` (the WS
 *     broadcast). Polling is DEMAND-GATED: it only runs while a WS client is
 *     subscribed (`retain`/`release`) or a route recently touched it (`touch`),
 *     idle-stopping after `idleTimeoutMs` of no interest so we never spawn
 *     nvidia-smi forever in the background.
 */

import { cpus, totalmem, freemem } from "node:os";
import {
  createNvidiaConnector,
  type Connector,
  type ConnectorReading,
  type NvidiaPerfTelemetry,
} from "@tac/connectors";
import type { NvidiaSmiRunner } from "@tac/environment";

/** One point on the live telemetry graph. `gpu` is absent on non-NVIDIA hosts / failed reads. */
export interface TelemetrySample {
  /** ISO-8601 capture time. */
  ts: string;
  system: {
    /** Host CPU utilization %, 0–100 (from `os.cpus()` deltas between samples). */
    cpuPct: number;
    /** System RAM in use, MiB. */
    memUsedMiB: number;
    /** Total system RAM, MiB. */
    memTotalMiB: number;
  };
  /** Present only when an NVIDIA GPU was detected and nvidia-smi answered. */
  gpu?: {
    /** GPU core utilization, %. */
    utilPct: number;
    /** VRAM in use, MiB. */
    memUsedMiB: number;
    /** Total VRAM, MiB. */
    memTotalMiB: number;
    /** Graphics (core) clock, MHz. */
    coreClockMhz: number;
    /** GPU temperature, °C. */
    tempC: number;
    /** Board power draw, W. */
    powerW: number;
  };
}

/** Default poll period (ms). */
export const DEFAULT_TELEMETRY_INTERVAL_MS = 2000;
/** Ring-buffer cap ≈ 15 min at the default 2 s cadence. */
export const DEFAULT_TELEMETRY_BUFFER_CAP = 450;
/** Idle before demand-gated polling stops once nothing is interested (ms). */
export const DEFAULT_TELEMETRY_IDLE_MS = 30_000;

const PERF_TELEMETRY = "perf-telemetry" as const;
const BYTES_PER_MIB = 1024 * 1024;

/** Aggregate `os.cpus()` snapshot: summed idle + total tick counters across all cores. */
interface CpuSnapshot {
  idle: number;
  total: number;
}

/** Minimal shape of one `os.cpus()` entry the sampler reads (extra fields ignored). */
interface CpuTimesLike {
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

/**
 * The `node:os` surface the sampler touches — injectable so tests drive CPU deltas
 * and memory deterministically without shelling into the real host.
 */
export interface OsReader {
  cpus(): CpuTimesLike[];
  totalmem(): number;
  freemem(): number;
}

/** Real `node:os` reader (production default). */
export const defaultOsReader: OsReader = {
  cpus: () => cpus(),
  totalmem: () => totalmem(),
  freemem: () => freemem(),
};

function cpuSnapshot(reader: OsReader): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of reader.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function bytesToMiB(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MIB);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

export interface TelemetrySamplerOptions {
  /** Injectable `node:os` reader (tests); defaults to the real host. */
  os?: OsReader;
  /**
   * Injectable nvidia-smi runner passed straight through to the NVIDIA connector
   * (tests pass a fake CSV emitter). Absent → the connector shells out to real
   * nvidia-smi.
   */
  smiRunner?: NvidiaSmiRunner;
  /** Pre-built connector override (tests may inject a fake). Wins over `smiRunner`. */
  gpuConnector?: Connector;
  /** Injectable clock for a deterministic `ts` (tests). */
  clock?: () => Date;
}

export class TelemetrySampler {
  private readonly os: OsReader;
  private readonly nvidia: Connector;
  private readonly clock: () => Date;
  private prevCpu: CpuSnapshot;

  constructor(opts: TelemetrySamplerOptions = {}) {
    this.os = opts.os ?? defaultOsReader;
    this.clock = opts.clock ?? (() => new Date());
    this.nvidia =
      opts.gpuConnector ??
      createNvidiaConnector(opts.smiRunner ? { smiRunner: opts.smiRunner } : {});
    // Prime the CPU delta baseline so the FIRST sample() is a real two-snapshot
    // delta rather than a since-boot average.
    this.prevCpu = cpuSnapshot(this.os);
  }

  /** Build one sample. Never throws — a GPU read failure degrades to a system-only sample. */
  async sample(): Promise<TelemetrySample> {
    const cur = cpuSnapshot(this.os);
    const idleDelta = cur.idle - this.prevCpu.idle;
    const totalDelta = cur.total - this.prevCpu.total;
    this.prevCpu = cur;
    const cpuPct = totalDelta > 0 ? clampPct(100 * (1 - idleDelta / totalDelta)) : 0;

    const total = this.os.totalmem();
    const free = this.os.freemem();

    const sample: TelemetrySample = {
      ts: this.clock().toISOString(),
      system: {
        cpuPct: round1(cpuPct),
        memUsedMiB: bytesToMiB(total - free),
        memTotalMiB: bytesToMiB(total),
      },
    };

    const gpu = await this.readGpu();
    if (gpu) sample.gpu = gpu;
    return sample;
  }

  /** GPU slice via the NVIDIA connector's `perf-telemetry` read; null when absent/failed. */
  private async readGpu(): Promise<NonNullable<TelemetrySample["gpu"]> | null> {
    try {
      const reading = (await this.nvidia.read(PERF_TELEMETRY)) as ConnectorReading<NvidiaPerfTelemetry>;
      const t = reading.data.telemetry;
      if (!t) return null;
      return {
        utilPct: t.gpuUtilPct,
        memUsedMiB: t.vramUsedMiB,
        memTotalMiB: t.vramTotalMiB,
        coreClockMhz: t.coreClockMhz,
        tempC: t.tempC,
        powerW: t.powerW,
      };
    } catch {
      return null;
    }
  }
}

type IntervalHandle = ReturnType<typeof setInterval>;
type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface TelemetrySchedulerOptions {
  /** The sample builder (usually a {@link TelemetrySampler}'s bound `sample`). */
  sample: () => Promise<TelemetrySample>;
  /** Poll period in ms (default {@link DEFAULT_TELEMETRY_INTERVAL_MS}). */
  intervalMs?: number;
  /** Ring-buffer cap (default {@link DEFAULT_TELEMETRY_BUFFER_CAP}). */
  bufferCap?: number;
  /** Idle-stop delay once nothing is interested (default {@link DEFAULT_TELEMETRY_IDLE_MS}). */
  idleTimeoutMs?: number;
  /** Called with each buffered sample (the WS broadcast). */
  onSample?: (sample: TelemetrySample) => void;
  /** Observe a rejected sample (default: swallow). */
  onError?: (err: unknown) => void;
  setIntervalFn?: (fn: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => TimeoutHandle;
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
}

export class TelemetryScheduler {
  readonly intervalMs: number;
  private readonly bufferCap: number;
  private readonly idleTimeoutMs: number;
  private readonly buffer: TelemetrySample[] = [];
  private handle: IntervalHandle | null = null;
  private idleHandle: TimeoutHandle | null = null;
  private subscribers = 0;
  private inFlight = false;
  private closed = false;

  private readonly setIntervalFn: (fn: () => void, ms: number) => IntervalHandle;
  private readonly clearIntervalFn: (handle: IntervalHandle) => void;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => TimeoutHandle;
  private readonly clearTimeoutFn: (handle: TimeoutHandle) => void;

  constructor(private readonly opts: TelemetrySchedulerOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_TELEMETRY_INTERVAL_MS;
    this.bufferCap = opts.bufferCap ?? DEFAULT_TELEMETRY_BUFFER_CAP;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_TELEMETRY_IDLE_MS;
    this.setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h));
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));
  }

  // -- demand gating ----------------------------------------------------------

  /** A persistent subscriber (a WS client) started; keeps polling alive. */
  retain(): void {
    if (this.closed) return;
    this.subscribers += 1;
    this.clearIdle();
    this.ensurePolling();
  }

  /** A persistent subscriber left; when the last one goes, arm the idle-stop. */
  release(): void {
    if (this.subscribers > 0) this.subscribers -= 1;
    if (this.subscribers === 0) this.scheduleIdle();
  }

  /** A one-shot interest (a `/api/telemetry/*` hit): ensure polling and (re)arm idle-stop. */
  touch(): void {
    if (this.closed) return;
    this.ensurePolling();
    this.scheduleIdle();
  }

  private ensurePolling(): void {
    if (this.handle !== null || this.closed) return;
    this.handle = this.setIntervalFn(() => void this.runOnce(), this.intervalMs);
    (this.handle as { unref?: () => void }).unref?.();
  }

  private stopPolling(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (this.subscribers > 0 || this.closed) return;
    this.idleHandle = this.setTimeoutFn(() => {
      this.idleHandle = null;
      this.stopPolling();
    }, this.idleTimeoutMs);
    (this.idleHandle as { unref?: () => void }).unref?.();
  }

  private clearIdle(): void {
    if (this.idleHandle === null) return;
    this.clearTimeoutFn(this.idleHandle);
    this.idleHandle = null;
  }

  // -- sampling ---------------------------------------------------------------

  /**
   * Take one sample now (the interval body, also directly callable by tests).
   * Coalesces (a tick firing while a sample is still in flight is dropped) and
   * never throws — a failed sample routes to `onError`.
   */
  async runOnce(): Promise<void> {
    if (this.inFlight || this.closed) return;
    this.inFlight = true;
    try {
      const sample = await this.opts.sample();
      this.push(sample);
      this.opts.onSample?.(sample);
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.inFlight = false;
    }
  }

  private push(sample: TelemetrySample): void {
    this.buffer.push(sample);
    if (this.buffer.length > this.bufferCap) {
      this.buffer.splice(0, this.buffer.length - this.bufferCap);
    }
  }

  // -- reads ------------------------------------------------------------------

  /** Latest buffered sample, or undefined if none yet. */
  latest(): TelemetrySample | undefined {
    return this.buffer[this.buffer.length - 1];
  }

  /**
   * The latest sample for `/api/telemetry/current`; triggers (and broadcasts) a
   * fresh sample when the buffer is empty. Touches demand so polling spins up.
   */
  async current(): Promise<TelemetrySample> {
    this.touch();
    if (this.buffer.length === 0) {
      const sample = await this.opts.sample();
      this.push(sample);
      this.opts.onSample?.(sample);
    }
    return this.latest()!;
  }

  /** Samples from the last `minutes` (all buffered when `minutes` is non-positive/NaN). */
  history(minutes: number): TelemetrySample[] {
    if (!Number.isFinite(minutes) || minutes <= 0) return [...this.buffer];
    const cutoff = Date.now() - minutes * 60_000;
    return this.buffer.filter((s) => {
      const t = Date.parse(s.ts);
      return Number.isNaN(t) || t >= cutoff;
    });
  }

  // -- status / lifecycle -----------------------------------------------------

  /** Whether the poll interval is currently armed. */
  get running(): boolean {
    return this.handle !== null;
  }

  get subscriberCount(): number {
    return this.subscribers;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Tear everything down (runtime shutdown). Idempotent; blocks any restart. */
  stop(): void {
    this.closed = true;
    this.stopPolling();
    this.clearIdle();
    this.subscribers = 0;
  }
}
