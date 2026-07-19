/**
 * @tier T0 (holds no credentials, touches no disk of its own; it only shapes a
 * prompt or wraps a payload the user hands it). The assisted-capture fallback.
 *
 * `manual-capture` connector (SPEC-8 M9.4 / principle 4). When no adapter exists
 * for a needed capability, this connector produces a structured *prompt* asking
 * the user to paste or screenshot the data; when a payload is supplied it wraps
 * that payload into the same provenance envelope as any other read. Occasional
 * prompts are acceptable (H2 "Coach" decision) — the goal is coverage.
 */
import type { Capability } from "../capabilities.js";
import {
  makeReading,
  systemClock,
  type Clock,
  type Connector,
  type ConnectorReading,
  type DetectResult,
  type HealthStatus,
} from "../connector.js";

const ID = "manual-capture";
const CAPABILITY: Capability = "manual-capture";

/** How the user may satisfy a manual-capture prompt. */
export type ManualCaptureInputMode = "paste" | "screenshot";

/** Descriptor returned when no payload is available yet — the UI renders this. */
export interface ManualCapturePrompt {
  kind: "prompt";
  /** Human-readable ask. */
  message: string;
  /** Accepted input modes (paste text / drop a screenshot for OCR). */
  accepts: ManualCaptureInputMode[];
  /** The capability this manual capture is standing in for, if any. */
  targetCapability?: Capability;
}

/** Wrapper distinguishing a filled capture from a pending prompt. */
export interface ManualCapturePayload<T = unknown> {
  kind: "payload";
  payload: T;
  /** The capability this capture is standing in for, if any. */
  targetCapability?: Capability;
}

export type ManualCaptureData<T = unknown> = ManualCapturePrompt | ManualCapturePayload<T>;

const DEFAULT_MESSAGE =
  "No connector covers this yet — paste the value or drop a screenshot and I'll read it.";

export interface ManualCaptureConnectorOptions<T = unknown> {
  /** If provided, `read` wraps this payload; if omitted, `read` returns a prompt. */
  payload?: T;
  /** Override the prompt message. */
  message?: string;
  /** Override accepted input modes (default: paste + screenshot). */
  accepts?: ManualCaptureInputMode[];
  /** The capability being substituted (surfaced in the prompt/payload). */
  targetCapability?: Capability;
  /** Injectable clock for deterministic `capturedAt`. */
  clock?: Clock;
}

/**
 * Build a manual-capture connector. Construct with `{ payload }` to wrap a
 * user-supplied value; construct without one to emit a prompt descriptor.
 */
export function createManualCaptureConnector<T = unknown>(
  opts: ManualCaptureConnectorOptions<T> = {},
): Connector {
  const clock = opts.clock ?? systemClock;

  return {
    id: ID,
    vendor: "Tarkov AI Companion (assisted capture)",
    capabilities: [CAPABILITY],
    riskTier: "T0",

    // Always available — it is the fallback of last resort.
    async detect(): Promise<DetectResult> {
      return { installed: true };
    },

    async read(cap: Capability): Promise<ConnectorReading<ManualCaptureData<T>>> {
      if (cap !== CAPABILITY) {
        throw new Error(`Connector "${ID}" cannot read capability "${cap}".`);
      }
      const data: ManualCaptureData<T> =
        opts.payload !== undefined
          ? {
              kind: "payload",
              payload: opts.payload,
              ...(opts.targetCapability !== undefined
                ? { targetCapability: opts.targetCapability }
                : {}),
            }
          : {
              kind: "prompt",
              message: opts.message ?? DEFAULT_MESSAGE,
              accepts: opts.accepts ?? ["paste", "screenshot"],
              ...(opts.targetCapability !== undefined
                ? { targetCapability: opts.targetCapability }
                : {}),
            };
      return makeReading({ connectorId: ID, capability: CAPABILITY, data }, clock);
    },

    // The fallback is always ready to prompt.
    async health(): Promise<HealthStatus> {
      return "connected";
    },
  };
}

/** Default instance — emits a prompt (no payload wired up). */
export const manualCaptureConnector = createManualCaptureConnector();
