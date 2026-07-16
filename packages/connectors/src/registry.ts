/**
 * @tier T0 (in-memory registry + capability resolver; no I/O of its own — it
 * only orchestrates connectors, which are themselves T0/T1).
 *
 * The connector registry and capability resolver (SPEC-8 M9.1). Auto-detection
 * on service start (health-based) and the manual-override (`opts.prefer`) path
 * both flow through `resolve`. The single hard guard: registration refuses any
 * connector above T1 — the account-safe-by-construction Never-list, enforced.
 */
import type { Capability } from "./capabilities.js";
import type { Connector, ConnectorReading, HealthStatus, RiskTier } from "./connector.js";

/** Tiers a connector may register at. Anything else is refused (SPEC-8 principle 2). */
const ALLOWED_TIERS: ReadonlySet<string> = new Set<RiskTier>(["T0", "T1"]);

export interface ResolveOptions {
  /** Manual override: force this connector id if it satisfies the capability. */
  prefer?: string;
}

/** Thrown when a connector above T1 (would-be process-contact) is registered. */
export class RiskTierRejectedError extends Error {
  constructor(
    readonly connectorId: string,
    readonly riskTier: string,
  ) {
    super(
      `Connector "${connectorId}" declares riskTier "${riskTier}"; ` +
        `only T0/T1 (out-of-process, no game contact) may register.`,
    );
    this.name = "RiskTierRejectedError";
  }
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  /**
   * Register a connector. Throws `RiskTierRejectedError` for any tier outside
   * T0/T1 (the value is checked at runtime, not just at the type level, since a
   * loosely-constructed or out-of-tree connector may lie about its tier).
   */
  register(connector: Connector): void {
    if (!ALLOWED_TIERS.has(connector.riskTier)) {
      throw new RiskTierRejectedError(connector.id, connector.riskTier);
    }
    this.connectors.set(connector.id, connector);
  }

  /** All registered connectors, in registration order. */
  list(): Connector[] {
    return [...this.connectors.values()];
  }

  /** Every registered connector advertising `cap`. */
  byCapability(cap: Capability): Connector[] {
    return this.list().filter((c) => c.capabilities.includes(cap));
  }

  /**
   * Pick the best connector for `cap`. `opts.prefer` forces a specific id (and
   * throws if that id is not a candidate). Otherwise the first `connected`
   * candidate wins; if none is connected, the first candidate is returned as a
   * best-effort fallback. Returns `undefined` when nothing satisfies `cap`.
   */
  async resolve(cap: Capability, opts?: ResolveOptions): Promise<Connector | undefined> {
    const candidates = this.byCapability(cap);
    if (candidates.length === 0) return undefined;

    if (opts?.prefer !== undefined) {
      const preferred = candidates.find((c) => c.id === opts.prefer);
      if (preferred) return preferred;
      throw new Error(
        `Preferred connector "${opts.prefer}" does not satisfy capability "${cap}".`,
      );
    }

    for (const candidate of candidates) {
      if ((await candidate.health()) === "connected") return candidate;
    }
    return candidates[0];
  }

  /**
   * Resolve then read. Throws a clear error when no connector satisfies `cap`
   * (or when a `prefer` override does not match — surfaced from `resolve`).
   */
  async read(cap: Capability, opts?: ResolveOptions): Promise<ConnectorReading> {
    const connector = await this.resolve(cap, opts);
    if (!connector) {
      throw new Error(`No connector satisfies capability "${cap}".`);
    }
    return connector.read(cap);
  }

  /** Health of every registered connector, keyed by connector id. */
  async healthAll(): Promise<Record<string, HealthStatus>> {
    const out: Record<string, HealthStatus> = {};
    for (const connector of this.list()) {
      out[connector.id] = await connector.health();
    }
    return out;
  }
}
