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
  /** Entry file relative to `cwd` for the dev path. Default `src/main.ts`. */
  readonly entry?: string;
  /**
   * Bundled ESM entry filename inside `<resources>/sidecars/` used by the
   * packaged path. Default `<name>.mjs` (matches build-sidecars.mjs output).
   */
  readonly bundledEntry?: string;
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
   * Whether the Electron app is running from a packaged build (`app.isPackaged`).
   * When true we launch the *bundled* sidecar ESM on the *bundled* Node 26
   * runtime; when false we use the dev path (`node --import tsx <src>`).
   * Injected (not read from `app`) so this stays a pure, unit-testable function.
   */
  readonly isPackaged?: boolean;
  /**
   * `process.resourcesPath` in a packaged build — the root that
   * electron-builder's `extraResources` populate. The bundled Node runtime is
   * at `<resourcesPath>/runtime/node.exe` and the sidecar bundles at
   * `<resourcesPath>/sidecars/<name>.mjs`. Required when `isPackaged` is true.
   */
  readonly resourcesPath?: string;
  /**
   * Dev-path runtime override. In dev this is the system Node 26 binary
   * (`node`), which runs the TypeScript entry via the tsx loader
   * (`--import tsx`). Ignored in packaged mode.
   */
  readonly nodeCommand?: string;
  /** Base environment to inherit; defaults to `process.env` at the call site. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

/** Join path segments with forward slashes (spawn-safe on Windows). */
function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/[/\\]+$/, ""))
    .join("/")
    .replace(/\\/g, "/");
}

/** Join a package dir + entry into a forward-slash path (spawn-safe on Windows). */
function entryPath(cwd: string, entry: string): string {
  return joinPath(cwd, entry);
}

/**
 * Build the spawn plan for one sidecar. Two forms, selected on `isPackaged`:
 *
 *   dev      : node --import tsx <cwd>/src/main.ts
 *   packaged : <resourcesPath>/runtime/node.exe <resourcesPath>/sidecars/<name>.mjs
 *
 * with the sidecar's port injected via its `portEnv` var plus any `extraEnv`.
 * The dev form runs the *same* code path as the package's `start` script (`tsx
 * src/main.ts`). The packaged form runs the standalone bundle produced by
 * build-sidecars.mjs on the Node 26 runtime dropped in by populate-runtime.mjs,
 * so the installed app needs neither pnpm nor tsx nor the workspace on disk.
 */
export function buildSidecarSpawn(cfg: SidecarConfig, options: BuildSpawnOptions = {}): SpawnPlan {
  const env: Record<string, string> = {};
  const baseEnv = options.baseEnv ?? {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === "string") env[k] = v;
  }
  env[cfg.portEnv] = String(cfg.port);
  for (const [k, v] of Object.entries(cfg.extraEnv ?? {})) env[k] = v;

  if (options.isPackaged) {
    if (!options.resourcesPath) {
      throw new Error("buildSidecarSpawn: resourcesPath is required when isPackaged is true");
    }
    const sidecarsDir = joinPath(options.resourcesPath, "sidecars");
    const runtime = joinPath(options.resourcesPath, "runtime", "node.exe");
    const bundledEntry = cfg.bundledEntry ?? `${cfg.name}.mjs`;
    return {
      command: runtime,
      args: [joinPath(sidecarsDir, bundledEntry)],
      cwd: sidecarsDir,
      env,
    };
  }

  const nodeCommand = options.nodeCommand ?? "node";
  const entry = cfg.entry ?? "src/main.ts";
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
