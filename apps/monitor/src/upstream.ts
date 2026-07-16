import type { MonitorEngine } from "./engine.js";

/**
 * Upstream WS client: connects to the service's /ws event stream (CONTRACTS
 * §5.3) as a plain consumer and feeds every frame to the engine. Uses the
 * global WebSocket (Node >= 22, CONTRACTS §2) with exponential-backoff
 * reconnect — modelled on apps/agent ReplanPipeline.
 * @tier T0
 */

export interface UpstreamOptions {
  /** service base URL, e.g. http://localhost:3141 */
  serviceUrl: string;
  engine: MonitorEngine;
  backoffMs?: number[];
  WebSocketImpl?: typeof WebSocket;
  log?: (msg: string) => void;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000];

export class UpstreamClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: UpstreamOptions) {}

  private get log(): (msg: string) => void {
    return this.opts.log ?? (() => {});
  }

  get wsUrl(): string {
    return this.opts.serviceUrl.replace(/\/$/, "").replace(/^http/, "ws") + "/ws";
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.opts.engine.setConnected(false);
  }

  private connect(): void {
    if (this.stopped) return;
    const WsImpl = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new WsImpl(this.wsUrl);
    } catch (err) {
      this.log(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.backoffIndex = 0;
      this.opts.engine.setConnected(true);
      this.log(`connected to ${this.wsUrl}`);
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      this.opts.engine.handleMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    ws.addEventListener("close", () => {
      this.opts.engine.setConnected(false);
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      /* close event follows; reconnect handled there */
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.backoffIndex, backoff.length - 1)]!;
    this.backoffIndex++;
    this.log(`disconnected; reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
