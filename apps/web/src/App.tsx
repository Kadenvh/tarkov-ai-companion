/**
 * App shell (CONTRACTS §6) — left nav, top status bar (profile / level / WS
 * badge / snapshot version), live raid banner, toasts, onboarding modal, and
 * the view switch. Dark, high-contrast, second-monitor glanceable.
 */

import { Component, useEffect, useState, type ReactNode } from "react";
import { useApp } from "./store";
import { mapDisplayName } from "./lib/maps";
import { TonightsPlan } from "./views/TonightsPlan";
import { GoalsView } from "./views/Goals";
import { QuartermasterView } from "./views/Quartermaster";
import { InsightsView } from "./views/Insights";
import { EnvironmentView } from "./views/Environment";
import { MapView } from "./views/MapView";
import { OnboardingModal } from "./views/Onboarding";

type ViewId = "plan" | "goals" | "quartermaster" | "insights" | "environment" | "map";

/** One broken view must never white-screen the shell — render the error in place. */
class ViewBoundary extends Component<
  { viewId: string; children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidUpdate(prev: { viewId: string }): void {
    if (prev.viewId !== this.props.viewId && this.state.error) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="card" style={{ margin: 24, padding: 20 }}>
          <strong>This view hit an error.</strong>
          <div className="task-reasons" style={{ marginTop: 8 }}>
            {String(this.state.error)} — the rest of the app keeps running; switch views or
            Refresh. Please report this.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "plan", label: "Tonight's Plan" },
  { id: "goals", label: "Goals" },
  { id: "quartermaster", label: "Quartermaster" },
  { id: "insights", label: "Insights" },
  { id: "environment", label: "Environment" },
  { id: "map", label: "Map" },
];

function StatusBar(): ReactNode {
  const { health, player, wsStatus, refreshAll } = useApp();
  return (
    <div className="statusbar">
      <span>
        <strong>{health?.profileKey ?? "no profile"}</strong>
        {health?.gameMode ? ` · ${health.gameMode}` : ""}
      </span>
      <span>
        level <strong>{player.level}</strong>
        {player.xp?.low !== undefined && player.xp?.high !== undefined
          ? ` (±${Math.max(0, Math.round((player.xp.high - player.xp.low) / 2)).toLocaleString("en-US")} xp)`
          : ""}
      </span>
      {player.faction ? <span>{player.faction}</span> : null}
      {player.prestige > 0 ? <span>prestige {player.prestige}</span> : null}
      <span className="grow" />
      {health?.snapshotVersion ? <span>data {health.snapshotVersion}</span> : null}
      <span className={`badge ${wsStatus === "open" ? "live" : wsStatus === "closed" ? "down" : "warn"}`}>
        <span className="dot" />
        {wsStatus === "open" ? "LIVE" : wsStatus === "connecting" ? "CONNECTING" : "OFFLINE"}
      </span>
      <button onClick={() => void refreshAll()}>Refresh</button>
    </div>
  );
}

function RaidBannerBar(): ReactNode {
  const { raidBanner } = useApp();
  const [, force] = useState(0);

  // let the banner age out visually (10 min) without a store change
  useEffect(() => {
    const timer = setInterval(() => force((x) => x + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!raidBanner || Date.now() - raidBanner.at > 10 * 60_000) return null;
  const map = raidBanner.map ? mapDisplayName(raidBanner.map) : "unknown map";
  return (
    <div className={`raid-banner ${raidBanner.kind}`}>
      {raidBanner.kind === "started"
        ? `▶ RAID IN PROGRESS — ${map}`
        : `■ RAID ENDED — ${map}${raidBanner.outcome ? ` · ${raidBanner.outcome.toUpperCase()}` : ""} — replanning`}
    </div>
  );
}

function Toasts(): ReactNode {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} onClick={() => dismissToast(toast.id)}>
          {toast.title ? <div className="t-title">{toast.title}</div> : null}
          {toast.message}
        </div>
      ))}
    </div>
  );
}

export function App(): ReactNode {
  const [view, setView] = useState<ViewId>("plan");
  const { health } = useApp();

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">TARKOV AI</div>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={view === v.id ? "active" : ""}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
        <div className="spacer" />
        <div className="foot">
          {health ? `service v${health.version}` : "service offline"}
          <br />
          T0/T1 only — never touches the game.
        </div>
      </nav>

      <div className="main">
        <StatusBar />
        <RaidBannerBar />
        <div className="content">
          <ViewBoundary viewId={view}>
            {view === "plan" ? <TonightsPlan /> : null}
            {view === "goals" ? <GoalsView /> : null}
            {view === "quartermaster" ? <QuartermasterView /> : null}
            {view === "insights" ? <InsightsView /> : null}
            {view === "environment" ? <EnvironmentView /> : null}
            {view === "map" ? <MapView /> : null}
          </ViewBoundary>
        </div>
      </div>

      <Toasts />
      <OnboardingModal />
    </div>
  );
}
