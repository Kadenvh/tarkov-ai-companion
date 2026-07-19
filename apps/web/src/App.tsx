/**
 * App shell (CONTRACTS §6) — verb-first left nav (Operate / Understand / Ask /
 * Environment), HUD status strip (profile / level / goal / snapshot / WS LED),
 * live raid banner, toasts, onboarding modal, and the view switch. Dark-
 * committed tactical console, second-monitor glanceable.
 */

import { Component, useEffect, useState, type ReactNode } from "react";
import { useApp } from "./store";
import { mapDisplayName } from "./lib/maps";
import { TonightsPlan } from "./views/TonightsPlan";
import { ThisRaidView } from "./views/ThisRaid";
import { GoalsView } from "./views/Goals";
import { QuartermasterView } from "./views/Quartermaster";
import { DebriefView } from "./views/Debrief";
import { CopilotView } from "./views/Copilot";
import { EnvironmentView } from "./views/Environment";
import { MapView } from "./views/MapView";
import { SourcesView } from "./views/Sources";
import { OnboardingModal } from "./views/Onboarding";

type ViewId =
  | "plan"
  | "raid"
  | "quartermaster"
  | "goals"
  | "debrief"
  | "copilot"
  | "environment"
  | "map"
  | "sources";

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

interface NavItem {
  id: ViewId;
  label: string;
  icon: string;
}

const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Operate",
    items: [
      { id: "plan", label: "Tonight's Plan", icon: "◈" },
      { id: "raid", label: "This Raid", icon: "▸" },
      { id: "quartermaster", label: "Quartermaster", icon: "▤" },
    ],
  },
  {
    label: "Understand",
    items: [
      { id: "goals", label: "Goals & Foresight", icon: "◇" },
      { id: "debrief", label: "Debrief", icon: "◔" },
    ],
  },
  {
    label: "Ask",
    items: [{ id: "copilot", label: "Copilot", icon: "✦" }],
  },
  {
    label: "Environment",
    items: [
      { id: "environment", label: "Settings & Perf", icon: "⚙" },
      { id: "map", label: "Map", icon: "◱" },
      { id: "sources", label: "Sources & Connectors", icon: "⇄" },
    ],
  },
];

function StatusBar(): ReactNode {
  const { health, player, wsStatus, goals, refreshAll } = useApp();
  const goalLabels = (goals?.goals ?? []).map((g) => {
    switch (g.type) {
      case "kappa":
        return "Kappa";
      case "lightkeeper":
        return "Lightkeeper";
      case "level":
        return `Level ${g.level}`;
      case "tasks":
        return `${g.ids.length} custom`;
    }
  });
  const xpSpread =
    player.xp?.low !== undefined && player.xp?.high !== undefined
      ? `±${Math.max(0, Math.round((player.xp.high - player.xp.low) / 2)).toLocaleString("en-US")} xp`
      : "";

  // Game-mode chip accent: PvE → blue tokens, everything else (regular/PvP) → tan tokens.
  const modeClass = health?.gameMode
    ? health.gameMode.toLowerCase().includes("pve")
      ? "pve"
      : "pvp"
    : "";

  return (
    <div className="statusbar hud" data-mode={modeClass || undefined}>
      <div className="stat">
        <span className="k">Profile</span>
        <span className="v">
          <strong>{health?.profileKey ?? "no profile"}</strong>
          {health?.gameMode ? (
            <>
              {" "}
              <span className={`modechip ${modeClass}`}>{health.gameMode}</span>
            </>
          ) : null}
        </span>
      </div>
      <div className="stat">
        <span className="k">Level</span>
        <span className="v mono">
          {player.level}
          {xpSpread ? <span className="faint"> {xpSpread}</span> : null}
        </span>
      </div>
      {goalLabels.length > 0 ? (
        <div className="stat">
          <span className="k">Goal</span>
          <span className="v">{goalLabels.join(" · ")}</span>
        </div>
      ) : null}
      {player.faction ? (
        <div className="stat">
          <span className="k">Faction</span>
          <span className="v">{player.faction}</span>
        </div>
      ) : null}
      {player.prestige > 0 ? (
        <div className="stat">
          <span className="k">Prestige</span>
          <span className="v mono">{player.prestige}</span>
        </div>
      ) : null}

      <span className="grow" />

      {health?.snapshotVersion ? (
        <div className="stat">
          <span className="k">Data</span>
          <span className="v mono">{health.snapshotVersion}</span>
        </div>
      ) : null}
      <span
        className={`pill ${wsStatus === "open" ? "live" : wsStatus === "closed" ? "down" : "warn"}`}
      >
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
        <div className="brand">
          <div className="mark">
            TARKOV <b>AI</b>
          </div>
          <div className="tag">The Coach</div>
        </div>

        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            <div className="navlabel">{section.label}</div>
            {section.items.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                onClick={() => setView(item.id)}
              >
                <span className="ic">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        ))}

        <div className="spacer" />
        <div className="foot">
          {health ? (
            <>
              service v{health.version} · <span className="mono">3141</span>
            </>
          ) : (
            "service offline"
          )}
          <br />
          <span className="safe">T0/T1 only</span> — never touches the game.
        </div>
      </nav>

      <div className="main">
        <StatusBar />
        <RaidBannerBar />
        <div className="content">
          <ViewBoundary viewId={view}>
            {view === "plan" ? <TonightsPlan /> : null}
            {view === "raid" ? <ThisRaidView /> : null}
            {view === "quartermaster" ? <QuartermasterView /> : null}
            {view === "goals" ? <GoalsView /> : null}
            {view === "debrief" ? <DebriefView /> : null}
            {view === "copilot" ? <CopilotView /> : null}
            {view === "environment" ? <EnvironmentView /> : null}
            {view === "map" ? <MapView /> : null}
            {view === "sources" ? <SourcesView /> : null}
          </ViewBoundary>
        </div>
      </div>

      <Toasts />
      <OnboardingModal />
    </div>
  );
}
