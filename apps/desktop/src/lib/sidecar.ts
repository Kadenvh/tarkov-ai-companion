/**
 * Pure helpers for the sidecar lifecycle: build the spawn command/args/env for
 * each Node service the shell supervises, and terminate a set of tracked child
 * handles on shutdown. Kept side-effect-free (no real `spawn`, no real `kill`)
 * so the argument construction and shutdown fan-out are unit-testable.
 *
 * The shell supervises OUR Node services only — @tac/service (:3141) and
 * @tac/agent (:3142). It never launches or contacts the game process.
 *
 * @tier T0
 */

export type SidecarName = "service" | "agent";

export interface SidecarConfig {
  readonly name: SidecarName;
  /** pnpm workspace filter, e.g. `@tac/service`. */
  readonly filter: string;
  /** Env var the sidecar reads its own port from (`TAC_PORT` / `TAC_AGENT_PORT`). */
  readonly portEnv: string;
  /** Chosen port for this sidecar. */
  readonly port: number;
  /** Absolute path to the sidecar package dir (used as spawn cwd + entry base). */
  readonly cwd: string;
  /** Entry file relative to `cwd`. Default `src/main.ts`. */
  readonly entry?: string;
  /** Extra env vars merged last (e.g. agent → TAC_SERVICE_URL). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface SpawnPlan {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface BuildSpawnOptions {
  /**
   * Runtime to launch. In dev this is the system Node 26 binary (`node`), which
   * runs the TypeScript entry via the tsx loader (`--import tsx`). A packaged
   * build overrides this with the bundled Node runtime + compiled JS entry.
   */
  readonly nodeCommand?: string;
  /** Base environment to inherit; defaults to `process.env` at the call site. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

/** Join a package dir + entry into a forward-slash path (spawn-safe on Windows). */
function entryPath(cwd: string, entry: string): string {
  const base = cwd.replace(/[/\\]+$/, "");
  return `${base}/${entry}`;
}

/**
 * Build the spawn plan for one sidecar. Default form:
 *
 *   node --import tsx <cwd>/src/main.ts
 *
 * with the sidecar's port injected via its `portEnv` var plus any `extraEnv`.
 * This runs the *same* code path as the package's `start` script (`tsx
 * src/main.ts`) but on the explicit Node runtime we pass, so we can point it at
 * a bundled Node 26 in a packaged build.
 */
export function buildSidecarSpawn(cfg: SidecarConfig, options: BuildSpawnOptions = {}): SpawnPlan {
  const nodeCommand = options.nodeCommand ?? "node";
  const entry = cfg.entry ?? "src/main.ts";

  const env: Record<string, string> = {};
  const baseEnv = options.baseEnv ?? {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === "string") env[k] = v;
  }
  env[cfg.portEnv] = String(cfg.port);
  for (const [k, v] of Object.entries(cfg.extraEnv ?? {})) env[k] = v;

  return {
    command: nodeCommand,
    args: ["--import", "tsx", entryPath(cfg.cwd, entry)],
    cwd: cfg.cwd,
    env,
  };
}

/** The subset of a `ChildProcess` we need for shutdown — easy to fake in tests. */
export interface Killable {
  readonly pid?: number | undefined;
  readonly killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface TerminateResult {
  readonly attempted: number;
  readonly signalled: number[];
}

/**
 * Send `signal` to every tracked, still-alive child. Already-killed or
 * pid-less handles are skipped. Returns the pids we actually signalled so the
 * caller can log / verify no orphans remain.
 */
export function terminateAll(
  procs: readonly Killable[],
  signal: NodeJS.Signals = "SIGTERM",
): TerminateResult {
  const signalled: number[] = [];
  for (const proc of procs) {
    if (proc.killed) continue;
    if (proc.pid === undefined) continue;
    const ok = proc.kill(signal);
    if (ok) signalled.push(proc.pid);
  }
  return { attempted: procs.length, signalled };
}

export interface BackoffOptions {
  /** First restart delay in ms. Default 500. */
  readonly baseMs?: number;
  /** Cap on the delay in ms. Default 10_000. */
  readonly maxMs?: number;
  /** Restarts allowed inside `windowMs` before we stop trying. Default 5. */
  readonly maxRestarts?: number;
}

/**
 * Capped exponential backoff for crash-restart. `attempt` is 1-based (the first
 * restart after a crash is attempt 1). Returns `null` once `maxRestarts` is
 * exceeded, signalling the supervisor to give up.
 */
export function restartDelay(attempt: number, options: BackoffOptions = {}): number | null {
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 10_000;
  const maxRestarts = options.maxRestarts ?? 5;
  if (attempt < 1 || attempt > maxRestarts) return null;
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}
