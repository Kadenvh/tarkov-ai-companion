/**
 * @tier T0 (opt-in crowdsourced WRITES to tarkov.dev's community manager API;
 * anonymous queue times + de-dup-keyed goons sightings. No game process, memory,
 * input, or packets are ever touched — the payloads originate from data the user
 * already surfaced elsewhere. OFF BY DEFAULT.).
 *
 * The `submit` source (SPEC-10 M10.4). This re-expresses TarkovMonitor's optional
 * contributions (already live in `@tac/monitor`'s `submit.ts`) as a first-class
 * Source so the registry and status surface see it — but it stays a WRITE path,
 * so it is **opt-in and OFF by default**: `submit()` throws `SubmitDisabledError`
 * unless the source was built with `{ enabled: true }`, and the service registers
 * it disabled with no submit route exposed.
 *
 * Endpoint + payload shapes are verified against the-hideout/TarkovMonitor
 * (research/09): base `https://manager.tarkov.dev/api`,
 *  - `POST /queue`  {map, time, type, gameMode}                       — anonymous
 *  - `POST /goons`  {map, gameMode, timestamp(UnixMS), accountId(int)} — de-dup keyed
 * These mirror `apps/monitor/src/submit.ts` exactly.
 *
 * Reads: there are none — this is a write-only endpoint, so `fetch()` throws.
 * `health()` reports opt-in state without a network probe (POST-only API; mirrors
 * the TarkovTracker "no probe, conserve the wire" rationale): disabled → `missing`,
 * a recorded submit error → `error`, otherwise `connected`.
 */
import type { GameMode } from "@tac/shared";
import type { SourceCapability } from "../capabilities.js";
import {
  systemMsClock,
  type HealthStatus,
  type MsClock,
  type Source,
  type SourceReading,
  type SourceRequest,
  type SourceStats,
} from "../source.js";
import { DEFAULT_USER_AGENT, type FetchLike } from "../http.js";

const ID = "tarkov-dev-manager";
const DEFAULT_BASE_URL = "https://manager.tarkov.dev/api";
const SUBMIT_CAPABILITY: SourceCapability = "submit";

/** The kinds of submission the manager API accepts. */
export type SubmitKind = "queue" | "goons";

/** `POST /queue` payload — anonymous queue-time contribution (monitor's shape). */
export interface QueueSubmission {
  /** tarkov.dev map dev id. */
  map: string;
  /** Measured queue time in seconds. */
  time: number;
  /** Queue type label (TarkovMonitor's `type`, e.g. PVP/scav). */
  type: string;
  gameMode: GameMode;
}

/** `POST /goons` payload — goons sighting (de-dup keyed by account). */
export interface GoonsSubmission {
  /** tarkov.dev map dev id. */
  map: string;
  gameMode: GameMode;
  /** Integer account id (de-dup key), or null when unknown. */
  accountId: number | null;
  /** Unix milliseconds; defaults to the source clock when omitted. */
  timestamp?: number;
}

/** Result of a submission POST. */
export interface SubmitResult {
  path: string;
  status: number;
  ok: boolean;
}

/** Thrown when `submit()` is called on a source that was not opted in. */
export class SubmitDisabledError extends Error {
  constructor(readonly sourceId: string) {
    super(
      `Source "${sourceId}" is submit-disabled (opt-in, off by default). ` +
        `Build it with { enabled: true } to allow crowdsourced submissions.`,
    );
    this.name = "SubmitDisabledError";
  }
}

/** The manager source: a `Source` plus the opt-in `submit()` write path. */
export interface TarkovDevManagerSource extends Source {
  /** Whether submissions are enabled (opt-in). */
  readonly enabled: boolean;
  /** Contribute a crowdsourced reading. Throws `SubmitDisabledError` when disabled. */
  submit(kind: "queue", payload: QueueSubmission): Promise<SubmitResult>;
  submit(kind: "goons", payload: GoonsSubmission): Promise<SubmitResult>;
}

export interface TarkovDevManagerSourceOptions {
  /** Opt-in switch. DEFAULT FALSE — `submit()` throws until this is true. */
  enabled?: boolean;
  /** Override the base URL (env `TAC_TARKOVDEV_MANAGER_URL`, else the live default). */
  baseUrl?: string;
  /** Injectable transport (fixtures in tests). */
  fetchImpl?: FetchLike;
  /** Injectable epoch-ms clock (goons timestamp). */
  now?: MsClock;
  /** Override the User-Agent. */
  userAgent?: string;
}

const globalFetchImpl: FetchLike = (url, init) =>
  (globalThis.fetch as unknown as FetchLike)(url, init);

/** Normalize to the API's `regular`|`pve` literal (mirrors monitor's `submit.ts`). */
function apiGameMode(mode: GameMode): "regular" | "pve" {
  return mode === "pve" ? "pve" : "regular";
}

/**
 * Build the tarkov.dev-manager `submit` source. Default-OFF: `submit()` throws
 * `SubmitDisabledError` unless `{ enabled: true }`. `fetch()` always throws
 * (write-only endpoint); `health()` reports opt-in state without a network probe.
 */
export function createTarkovDevManagerSource(
  opts: TarkovDevManagerSourceOptions = {},
): TarkovDevManagerSource {
  const baseUrl = (
    opts.baseUrl ??
    process.env["TAC_TARKOVDEV_MANAGER_URL"] ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const enabled = opts.enabled ?? false;
  const fetchImpl = opts.fetchImpl ?? globalFetchImpl;
  const now = opts.now ?? systemMsClock;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  let lastError: string | undefined;

  async function post(path: string, body: unknown): Promise<SubmitResult> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "User-Agent": userAgent, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const ok = res.status >= 200 && res.status < 300;
    lastError = ok ? undefined : `submit ${path} -> ${res.status}`;
    return { path, status: res.status, ok };
  }

  return {
    id: ID,
    kind: "rest",
    baseUrl,
    capabilities: [SUBMIT_CAPABILITY],
    enabled,

    async submit(kind: SubmitKind, payload: QueueSubmission | GoonsSubmission): Promise<SubmitResult> {
      if (!enabled) throw new SubmitDisabledError(ID);
      if (kind === "queue") {
        const p = payload as QueueSubmission;
        return post("/queue", {
          map: p.map,
          time: p.time,
          type: p.type,
          gameMode: apiGameMode(p.gameMode),
        });
      }
      const p = payload as GoonsSubmission;
      return post("/goons", {
        map: p.map,
        gameMode: apiGameMode(p.gameMode),
        timestamp: p.timestamp ?? now(),
        accountId: p.accountId,
      });
    },

    // Write-only endpoint — there is nothing to read.
    async fetch<T = unknown>(_req: SourceRequest): Promise<SourceReading<T>> {
      throw new Error(`Source "${ID}" is submit-only; use submit(), not fetch().`);
    },

    async health(): Promise<HealthStatus> {
      if (!enabled) return "missing"; // opt-in off → surfaced as unconfigured/down.
      if (lastError !== undefined) return "error";
      return "connected";
    },

    stats(): SourceStats {
      return lastError !== undefined ? { lastError } : {};
    },
  };
}
