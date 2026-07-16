/**
 * @tier T0 (types + pure provenance-stamping/hashing helpers; no I/O, no
 * process contact, no network of its own — the network lives in http.ts and the
 * concrete sources).
 *
 * The Source contract (SPEC-10 M10.1). Every remote data feed — tarkov.dev JSON,
 * TarkovTracker, later the EFT wiki — implements `Source`. This mirrors
 * `@tac/connectors`' `Connector`/`ConnectorReading`/`HealthStatus` shapes on
 * purpose: they are the same provenance-envelope idea applied to remote data.
 *
 * SHARED-SHAPE NOTE: `HealthStatus`, the provenance envelope (`SourceReading`),
 * `makeReading`, and `hashData` are intentional duplicates of the ones in
 * `@tac/connectors`. They SHOULD be hoisted into `@tac/shared` and consumed by
 * both layers (SPEC-10 §Design: "extract the shared envelope/health into
 * @tac/shared"). We do NOT refactor `@tac/connectors` in this slice — the hoist
 * is a follow-up so the two layers can land independently.
 */
import { createHash } from "node:crypto";
import type { SourceCapability } from "./capabilities.js";

/** Transport family of a source. Prefer `rest` (JSON API) over `graphql` (in maintenance). */
export type SourceKind = "rest" | "graphql" | "mediawiki";

/** How live a source is right now. Same vocabulary as `@tac/connectors`. */
export type HealthStatus = "connected" | "stale" | "missing" | "error";

/** Wall-clock abstraction (ISO-8601 strings) so `fetchedAt` is deterministic in tests. */
export type Clock = () => string;

/** Default ISO wall-clock. */
export const systemClock: Clock = () => new Date().toISOString();

/** Millisecond clock (epoch ms) for TTL/quota math; injectable in tests. */
export type MsClock = () => number;

/** Default epoch-ms clock. */
export const systemMsClock: MsClock = () => Date.now();

/**
 * A request for one capability's data from a source. `path` is relative to the
 * source `baseUrl` (e.g. "/regular/tasks", "/regular/prices/<id>"). Callers may
 * override the cache key or TTL; otherwise the source applies its own policy.
 */
export interface SourceRequest {
  capability: SourceCapability;
  /** Path relative to `baseUrl`, e.g. "/regular/tasks". */
  path: string;
  /** Override cache key (defaults to the resolved URL). */
  cacheKey?: string;
  /** Override TTL in ms (defaults to a per-capability policy). */
  ttlMs?: number;
  /** Extra request headers (merged over the source's defaults). */
  headers?: Record<string, string>;
}

/**
 * Provenance envelope around every source read (SPEC-10). `fetchedAt` is the
 * stamp time; `fromCache` distinguishes a fresh network read (or a 304 revalidate)
 * from a TTL cache hit; `etag` is carried for conditional requests.
 */
export interface SourceReading<T = unknown> {
  sourceId: string;
  capability: SourceCapability;
  /** ISO-8601 timestamp (stamped by `makeReading`, injectable clock in tests). */
  fetchedAt: string;
  /** True when served from the TTL cache or a 304 revalidate (no fresh body parsed). */
  fromCache: boolean;
  /** Entity tag of the payload, when the source supports conditional requests. */
  etag?: string;
  data: T;
}

/** Read/write budget remaining for a quota-metered source (TarkovTracker). */
export interface QuotaState {
  readsRemaining?: number;
  writesRemaining?: number;
  /** ISO-8601 instant the budget resets, when known. */
  resetsAt?: string;
}

/**
 * Optional introspection a source may expose for the status surface (M10.3).
 * The registry folds this into `SourceStatus`; sources that omit it simply
 * contribute `{ id, up }` (+ quota if any).
 */
export interface SourceStats {
  /** Version/build string sniffed from a status probe, when available. */
  apiVersion?: string;
  /** ISO-8601 time of the last real network fetch (not cache hits). */
  lastFetch?: string;
  /** Age of the currently-cached payload, in seconds. */
  cacheAgeSec?: number;
  /** Last error message observed by the source, if any. */
  lastError?: string;
}

/**
 * The pluggable remote-source contract. Exactly the shape in SPEC-10, plus an
 * optional `stats()` hook that feeds the M10.3 status array (the interface core
 * — `health`/`fetch`/`quota` — is unchanged; `stats` is additive and optional).
 */
export interface Source {
  /** Stable id, e.g. "tarkov-dev-json" | "tarkovtracker" | "eft-wiki". */
  id: string;
  kind: SourceKind;
  baseUrl: string;
  /** Capabilities this source can satisfy. */
  capabilities: SourceCapability[];
  /** Live health of the backing feed (cheap; must send a real UA — TT 403s otherwise). */
  health(): Promise<HealthStatus>;
  /** Cache-first, conditional, retrying, budget-aware read. */
  fetch<T = unknown>(req: SourceRequest): Promise<SourceReading<T>>;
  /** Remaining budget (TarkovTracker); absent on un-metered sources. */
  quota?(): QuotaState;
  /** Optional status introspection (M10.3). */
  stats?(): SourceStats;
}

/**
 * Stable content hash of a payload (sorted keys → order-independent; sha256
 * truncated to 16 hex). Mirror of `@tac/connectors`' `hashData`; a de-dupe /
 * change-detection key for cached snapshots. Hoist to `@tac/shared` later.
 */
export function hashData(data: unknown): string {
  const json = JSON.stringify(data, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = obj[k];
          return acc;
        }, {});
    }
    return value;
  });
  return createHash("sha256").update(json ?? "null").digest("hex").slice(0, 16);
}

/**
 * Stamp a provenance envelope. `clock` defaults to wall-clock; inject a fixed
 * clock in tests so `fetchedAt` is deterministic. Optional `etag` is omitted
 * (not set to `undefined`) to satisfy `exactOptionalPropertyTypes`.
 */
export function makeReading<T>(
  input: {
    sourceId: string;
    capability: SourceCapability;
    data: T;
    fromCache: boolean;
    etag?: string;
  },
  clock: Clock = systemClock,
): SourceReading<T> {
  return {
    sourceId: input.sourceId,
    capability: input.capability,
    fetchedAt: clock(),
    fromCache: input.fromCache,
    data: input.data,
    ...(input.etag !== undefined ? { etag: input.etag } : {}),
  };
}
