import type { EngineEventName, ProfileStore } from "@tac/state-engine";
import type { Metrics } from "./metrics.js";

/**
 * WS broadcast hub (CONTRACTS §5.3): bridges the state-engine emitter events
 * (§3 names, verbatim) plus the service-level `plan.updated` and `notice`
 * frames to every connected client. Wire format:
 *   { type: <event name> | "plan.updated" | "notice" | "hello", payload, ts }
 * On connect the hub sends `{ type: "hello", payload: { profileKey } }`.
 */

/** Minimal socket surface (matches ws.WebSocket without importing its types). */
export interface HubSocket {
  readyState: number;
  send(data: string): void;
  on(event: "close", listener: () => void): unknown;
}

const OPEN = 1;

/** Every CONTRACTS §3 event, forwarded verbatim. */
export const ENGINE_EVENTS: readonly EngineEventName[] = [
  "raid.created",
  "raid.confirmed",
  "raid.started",
  "raid.ended",
  "quest.changed",
  "flea.sale",
  "position",
  "profile.detected",
  "patch.detected",
  "state.changed",
];

export class WsHub {
  private readonly sockets = new Set<HubSocket>();
  private unbind: (() => void) | null = null;

  constructor(
    public profileKey: string,
    private readonly metrics?: Metrics,
  ) {}

  get clientCount(): number {
    return this.sockets.size;
  }

  add(socket: HubSocket): void {
    this.sockets.add(socket);
    this.metrics?.wsConnected(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.metrics?.wsDisconnected(socket);
    });
    this.sendTo(socket, { type: "hello", payload: { profileKey: this.profileKey }, ts: new Date().toISOString() });
  }

  broadcast(type: string, payload: unknown): void {
    const frame = JSON.stringify({ type, payload, ts: new Date().toISOString() });
    for (const socket of this.sockets) {
      if (socket.readyState === OPEN) {
        try {
          socket.send(frame);
        } catch {
          // dead socket — its close handler will drop it
        }
      }
    }
  }

  /** Subscribe to a store's emitter, forwarding all §3 events. Rebindable on profile switch. */
  bindStore(store: ProfileStore): void {
    this.unbindStore();
    const listeners = ENGINE_EVENTS.map((event) => {
      const listener = (payload: unknown): void => this.broadcast(event, payload);
      store.events.on(event, listener as never);
      return { event, listener };
    });
    this.unbind = () => {
      for (const { event, listener } of listeners) store.events.off(event, listener as never);
    };
  }

  unbindStore(): void {
    this.unbind?.();
    this.unbind = null;
  }

  private sendTo(socket: HubSocket, frame: { type: string; payload: unknown; ts: string }): void {
    if (socket.readyState === OPEN) {
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        // ignore — connection raced shut
      }
    }
  }
}
