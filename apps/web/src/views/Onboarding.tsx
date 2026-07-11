/**
 * Onboarding modal (M2.6 quiz surface) — shown when the profile looks
 * untouched (level 1, no completed tasks). Three seeding paths:
 *  1. quick quiz (level / faction / prestige)  → POST /api/state/manual
 *  2. TarkovTracker token import               → POST /api/state/import/tarkovtracker
 *  3. historical log backfill                  → POST /api/state/backfill
 */

import { useState, type ReactNode } from "react";
import { useApp } from "../store";
import type { BackfillResult } from "../api/types";

export function OnboardingModal(): ReactNode {
  const { api, onboardingOpen, setOnboardingOpen, refreshAll, pushToast } = useApp();

  const [level, setLevel] = useState(1);
  const [faction, setFaction] = useState<"USEC" | "BEAR">("USEC");
  const [prestige, setPrestige] = useState(0);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"quiz" | "token" | "backfill" | null>(null);
  const [backfill, setBackfill] = useState<BackfillResult | null>(null);

  if (!onboardingOpen) return null;

  const close = (): void => setOnboardingOpen(false);

  const submitQuiz = async (): Promise<void> => {
    setBusy("quiz");
    try {
      await api.post("/api/state/manual", { level, faction, prestige });
      pushToast("info", `Profile seeded: level ${level} ${faction}.`);
      await refreshAll();
      close();
    } catch {
      /* toast pushed by client */
    } finally {
      setBusy(null);
    }
  };

  const importToken = async (): Promise<void> => {
    if (!token.trim()) return;
    setBusy("token");
    try {
      await api.post("/api/state/import/tarkovtracker", { token: token.trim() });
      pushToast("info", "TarkovTracker progress imported.");
      await refreshAll();
      close();
    } catch {
      /* toast pushed by client */
    } finally {
      setBusy(null);
    }
  };

  const runBackfill = async (): Promise<void> => {
    setBusy("backfill");
    setBackfill(null);
    try {
      const res = await api.post<BackfillResult>("/api/state/backfill");
      setBackfill(res);
      pushToast(
        "info",
        `Backfill done: ${res.questEventsApplied} quest events, ${res.raidsRecorded} raids from ${res.sessionsReplayed} sessions.`,
        "Historical backfill",
      );
      await refreshAll();
    } catch {
      /* toast pushed by client */
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Welcome — seed your profile</h3>
        <p className="sub">
          The profile looks fresh (level 1, nothing completed). Pick any of these — they compose.
        </p>

        <h3 style={{ marginTop: 18 }}>1 · Quick quiz</h3>
        <div className="row">
          <label>Level</label>
          <input
            type="number"
            min={1}
            max={79}
            style={{ width: 72 }}
            value={level}
            onChange={(e) => setLevel(Math.max(1, Math.min(79, Number(e.target.value) || 1)))}
          />
        </div>
        <div className="row">
          <label>Faction</label>
          <select value={faction} onChange={(e) => setFaction(e.target.value as "USEC" | "BEAR")}>
            <option value="USEC">USEC</option>
            <option value="BEAR">BEAR</option>
          </select>
        </div>
        <div className="row">
          <label>Prestige</label>
          <input
            type="number"
            min={0}
            max={10}
            style={{ width: 72 }}
            value={prestige}
            onChange={(e) => setPrestige(Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
        <button className="primary" disabled={busy !== null} onClick={() => void submitQuiz()}>
          {busy === "quiz" ? "Saving…" : "Save profile basics"}
        </button>

        <h3 style={{ marginTop: 22 }}>2 · Import from TarkovTracker</h3>
        <div className="row">
          <label>API token</label>
          <input
            style={{ flex: 1 }}
            placeholder="tarkovtracker.org → Settings → API token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <button disabled={busy !== null || !token.trim()} onClick={() => void importToken()}>
          {busy === "token" ? "Importing…" : "Import progress"}
        </button>

        <h3 style={{ marginTop: 22 }}>3 · Historical backfill</h3>
        <p className="sub">
          Replays every EFT log folder on disk (read-only) to reconstruct raids and quest history.
        </p>
        <button disabled={busy !== null} onClick={() => void runBackfill()}>
          {busy === "backfill" ? "Scanning logs…" : "Run historical backfill"}
        </button>
        {backfill ? (
          <div className="kv" style={{ marginTop: 10 }}>
            <span className="k">Sessions scanned</span>
            <span>{backfill.sessionsScanned}</span>
            <span className="k">Sessions replayed</span>
            <span>{backfill.sessionsReplayed}</span>
            <span className="k">Quest events</span>
            <span>{backfill.questEventsApplied}</span>
            <span className="k">Raids recorded</span>
            <span>{backfill.raidsRecorded}</span>
            <span className="k">Flea sales</span>
            <span>{backfill.fleaSalesRecorded}</span>
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 20, justifyContent: "flex-end" }}>
          <button onClick={close}>Skip for now</button>
        </div>
      </div>
    </div>
  );
}
