import type { GameMode } from "@tac/shared";
import type { Submitter } from "./engine.js";

/**
 * Crowdsourced submissions to tarkov.dev's community manager API, mirroring
 * TarkovMonitor's optional contributions:
 *   - queue times  (map, seconds, PMC/scav, PVP/PVE) — anonymous
 *   - goons sightings (map, timestamp, account id)   — identified for de-dup
 *
 * BOTH ARE OFF BY DEFAULT and gated by config opt-ins (see config.ts / the
 * engine). Fire-and-forget: a failed submission never disrupts monitoring.
 *
 * Endpoint + payload shapes are verified against the-hideout/TarkovMonitor
 * (TarkovDev.cs): base https://manager.tarkov.dev/api, `POST /queue`
 * {map,time,type,gameMode} and `POST /goons` {map,gameMode,timestamp,accountId}
 * where timestamp is Unix milliseconds and accountId is an integer. The base is
 * still env-overridable (TAC_TARKOVDEV_MANAGER_URL).
 * @tier T0
 */

const DEFAULT_BASE = "https://manager.tarkov.dev/api";

export interface SubmitterOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export class TarkovDevSubmitter implements Submitter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;

  constructor(opts: SubmitterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env["TAC_TARKOVDEV_MANAGER_URL"] ?? DEFAULT_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  queueTime(input: { mapDevId: string; queueSec: number; type: string; gameMode: GameMode }): void {
    void this.post("/queue", {
      map: input.mapDevId,
      time: input.queueSec,
      type: input.type,
      gameMode: input.gameMode === "pve" ? "pve" : "regular",
    });
  }

  goons(input: { mapDevId: string; accountId: string | null; gameMode: GameMode }): void {
    const n = input.accountId !== null ? Number(input.accountId) : NaN;
    void this.post("/goons", {
      map: input.mapDevId,
      gameMode: input.gameMode === "pve" ? "pve" : "regular",
      timestamp: Date.now(),
      accountId: Number.isFinite(n) ? n : null,
    });
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      const res = await this.fetchImpl(this.baseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) this.log(`submit ${path} -> ${res.status}`);
    } catch (err) {
      this.log(`submit ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
