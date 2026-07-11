/**
 * Reconnecting WebSocket hook for GET /ws (CONTRACTS §5.3).
 * All frame logic lives in frames.ts (pure, tested); this file only owns the
 * browser socket lifecycle: connect, exponential backoff reconnect, cleanup.
 */

import { useEffect, useRef, useState } from "react";
import { parseFrame, routeFrame, type FrameHandlers } from "./frames";

export type WsStatus = "connecting" | "open" | "closed";

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10_000;

export function wsUrl(loc: { protocol: string; host: string } = window.location): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${loc.host}/ws`;
}

/**
 * Subscribe to the service event stream. `handlers` is read through a ref so
 * callers may pass a fresh object every render without resubscribing.
 */
export function useServiceSocket(handlers: FrameHandlers): WsStatus {
  const [status, setStatus] = useState<WsStatus>("connecting");
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let disposed = false;
    let backoff = MIN_BACKOFF_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (disposed) return;
      setStatus("connecting");
      try {
        socket = new WebSocket(wsUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        backoff = MIN_BACKOFF_MS;
        setStatus("open");
      };
      socket.onmessage = (event) => {
        const frame = parseFrame(event.data);
        if (frame) routeFrame(frame, handlersRef.current);
      };
      socket.onclose = () => {
        setStatus("closed");
        scheduleReconnect();
      };
      socket.onerror = () => {
        socket?.close();
      };
    };

    const scheduleReconnect = (): void => {
      if (disposed) return;
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  return status;
}
