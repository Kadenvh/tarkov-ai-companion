import type { ModelClient } from "./model.js";
import type { ServiceClient } from "./service.js";
import { generateBriefing } from "./briefing.js";

/**
 * Event-driven replan pipeline (M4.4): subscribe to the service's /ws stream
 * (CONTRACTS §5.3), and on raid.ended -> debounce -> fetch the fresh plan ->
 * generate the next-raid briefing -> POST /api/notify (the service broadcasts
 * it as a WS "notice" toast).
 *
 * Uses the global WebSocket (Node >= 22, CONTRACTS §2). Auto-reconnects with
 * exponential backoff. Idempotence guard: one replan per raid end (keyed on
 * the raid sid, falling back to map+ts).
 * @tier T0
 */

export interface ReplanOptions {
  service: ServiceClient;
  client: ModelClient;
  /** debounce between raid.ended and replanning (default 3000 ms) */
  debounceMs?: number;
  /** reconnect backoff schedule in ms */
  backoffMs?: number[];
  /** injectable for tests */
  WebSocketImpl?: typeof WebSocket;
  log?: (msg: string) => void;
}

interface WsEvent {
  type?: string;
  payload?: { sid?: string; map?: string; ts?: string };
}

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_HANDLED_KEYS = 200;

export class ReplanPipeline {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffIndex = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly handled = new Set<string>();
  private pendingKey: string | null = null;
  /** resolves after each completed replan (test hook) */
  onReplanned: ((key: string) => void) | null = null;

  constructor(private readonly opts: ReplanOptions) {}

  private get log(): (msg: string) => void {
    return this.opts.log ?? (() => {});
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.debounceTimer = null;
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const WsImpl = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new WsImpl(this.opts.service.wsUrl);
    } catch (err) {
      this.log(`ws connect failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.backoffIndex = 0;
      this.log(`ws connected to ${this.opts.service.wsUrl}`);
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    ws.addEventListener("close", () => this.scheduleReconnect());
    ws.addEventListener("error", () => {
      /* close follows; reconnect handled there */
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.backoffIndex, backoff.length - 1)]!;
    this.backoffIndex++;
    this.log(`ws disconnected; reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onMessage(raw: string): void {
    let event: WsEvent;
    try {
      event = JSON.parse(raw) as WsEvent;
    } catch {
      return;
    }
    if (event.type !== "raid.ended") return;
    const key = event.payload?.sid ?? `${event.payload?.map ?? "?"}@${event.payload?.ts ?? "?"}`;
    if (this.handled.has(key)) {
      this.log(`raid.ended ${key} already handled — skipping`);
      return;
    }
    this.markHandled(key);
    this.pendingKey = key;
    // debounce: quest.changed / state.changed churn follows a raid end; wait
    // for the store to settle before replanning.
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.replan(this.pendingKey ?? key);
    }, this.opts.debounceMs ?? 3_000);
  }

  private markHandled(key: string): void {
    this.handled.add(key);
    if (this.handled.size > MAX_HANDLED_KEYS) {
      const first = this.handled.values().next().value;
      if (first !== undefined) this.handled.delete(first);
    }
  }

  private async replan(key: string): Promise<void> {
    try {
      // fresh plan (the service replans on read; this also warms its cache)
      await this.opts.service.get("/api/plan");
      const { briefing } = await generateBriefing(this.opts.client, this.opts.service, 1);
      await this.opts.service.post("/api/notify", {
        title: "Raid over — next raid is ready",
        body: briefing,
      });
      this.log(`replanned + notified for ${key}`);
      this.onReplanned?.(key);
    } catch (err) {
      this.log(`replan failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      // allow a later raid.ended to retry; drop the guard for this key
      this.handled.delete(key);
    }
  }
}
