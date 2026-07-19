/**
 * Copilot (CONTRACTS §5.5) — chat UI over the agent proxy. Sends
 * POST /api/agent/chat { message, sessionId? } (the service forwards to
 * apps/agent on 3142) and renders the conversation plus any tool-call
 * citations the agent attaches to its reply.
 *
 * The agent is a separate process: when it is down the service answers 503.
 * We surface that inline ("Copilot is offline — start the agent") and never
 * crash. A dedicated API client (no shared onError) keeps the offline notice
 * out of the global toast stream.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient, ApiError } from "../api/client";

interface Citation {
  label: string;
  detail?: string;
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
}

// ---------- tolerant readers (agent reply shape is not pinned by CONTRACTS) ----------

type Rec = Record<string, unknown>;
function rec(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Pull the assistant text out of whatever envelope the agent used. */
function readReplyText(raw: unknown): string {
  const root = rec(raw);
  if (!root) return typeof raw === "string" ? raw : "";
  const nested = rec(root["reply"]) ?? rec(root["message"]) ?? rec(root["result"]);
  return (
    str(root["reply"]) ??
    str(root["message"]) ??
    str(root["text"]) ??
    str(root["content"]) ??
    str(root["answer"]) ??
    str(nested?.["text"]) ??
    str(nested?.["content"]) ??
    str(nested?.["message"]) ??
    ""
  );
}

/** Read tool-call citations from any of the shapes the agent might emit. */
function readCitations(raw: unknown): Citation[] {
  const root = rec(raw);
  if (!root) return [];
  const nested = rec(root["reply"]) ?? rec(root["message"]) ?? rec(root["result"]);
  const list =
    (Array.isArray(root["toolCalls"]) && root["toolCalls"]) ||
    (Array.isArray(root["citations"]) && root["citations"]) ||
    (Array.isArray(root["tools"]) && root["tools"]) ||
    (nested && Array.isArray(nested["toolCalls"]) && nested["toolCalls"]) ||
    (nested && Array.isArray(nested["citations"]) && nested["citations"]) ||
    [];
  const out: Citation[] = [];
  for (const entry of list as unknown[]) {
    if (typeof entry === "string") {
      out.push({ label: entry });
      continue;
    }
    const r = rec(entry);
    if (!r) continue;
    const label = str(r["tool"]) ?? str(r["name"]) ?? str(r["source"]) ?? str(r["label"]) ?? str(r["endpoint"]);
    if (!label) continue;
    const detail = str(r["detail"]) ?? str(r["path"]) ?? str(r["summary"]) ?? str(r["query"]);
    out.push(detail ? { label, detail } : { label });
  }
  return out;
}

function readSessionId(raw: unknown): string | undefined {
  const root = rec(raw);
  return str(root?.["sessionId"]) ?? str(root?.["session"]);
}

let msgSeq = 1;

export function CopilotView(): ReactNode {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const logRef = useRef<HTMLDivElement | null>(null);

  // dedicated client — offline (503) is shown inline, not as a global toast
  const chatApi = useMemo(() => createClient(), []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, sending]);

  const send = async (): Promise<void> => {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setOffline(false);
    setMessages((m) => [...m, { id: msgSeq++, role: "user", text: message }]);
    setSending(true);
    try {
      const res = await chatApi.post<unknown>("/api/agent/chat", {
        message,
        ...(sessionId ? { sessionId } : {}),
      });
      const sid = readSessionId(res);
      if (sid) setSessionId(sid);
      const text = readReplyText(res) || "(no reply)";
      const citations = readCitations(res);
      setMessages((m) => [
        ...m,
        { id: msgSeq++, role: "assistant", text, ...(citations.length ? { citations } : {}) },
      ]);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 503 || err.isNetwork)) {
        setOffline(true);
      } else {
        const detail = err instanceof ApiError ? err.message : "unexpected error";
        setMessages((m) => [
          ...m,
          { id: msgSeq++, role: "assistant", text: `Couldn't reach the copilot — ${detail}.` },
        ]);
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div>
      <div className="pagehead">
        <h2>Copilot</h2>
        <span className="count">agent proxy · port 3142</span>
      </div>
      <p className="sub">
        Ask the coach anything — it reasons over your live state, plan, and story using the same
        service API you see here, and cites the tools it called.
      </p>

      {offline ? (
        <div className="chat-offline">
          <b>Copilot is offline — start the agent.</b> The service reached the agent proxy but got
          no answer (503). Run <code>pnpm agent</code> (apps/agent on port 3142), then send your
          message again. Nothing else in the app is affected.
        </div>
      ) : null}

      <div className="chat">
        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && !sending ? (
            <div className="empty">
              No messages yet. Try “What should I prioritize this session?” or “Is anything about to
              lock me out of Kappa?”
            </div>
          ) : null}
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              <span className="who">{m.role === "user" ? "You" : "Copilot"}</span>
              <div className="bubble">{m.text}</div>
              {m.citations && m.citations.length > 0 ? (
                <div className="chat-citations">
                  {m.citations.map((c, i) => (
                    <span key={i} className="chat-citation" title={c.detail ?? c.label}>
                      {c.label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {sending ? (
            <div className="chat-msg assistant pending">
              <span className="who">Copilot</span>
              <div className="bubble">thinking…</div>
            </div>
          ) : null}
        </div>

        <div className="chat-input">
          <textarea
            rows={2}
            placeholder="Ask the copilot…  (Enter to send, Shift+Enter for a newline)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="primary" disabled={sending || !input.trim()} onClick={() => void send()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
