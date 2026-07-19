/**
 * Goals dashboard (M5.3) — goal picker (kappa / lightkeeper / level N / custom
 * tasks), planner weights editor (map aversion sliders incl. the "hate
 * Lighthouse" preset + horizon), Kappa/LK progress bars, and the story tracker.
 *
 * POSTs the CONTRACTS §5.2 body { goals, weights }. Custom-task search tries
 * the optional GET /api/graph/tasks?q= extension (documented in SPEC-7) and
 * falls back to manual task-id entry when the service doesn't provide it.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store";
import { readGraphSummary } from "../lib/normalize";
import { MAP_REGISTRY } from "../lib/maps";
import { Empty, ProgressBar } from "../components/common";
import { StoryTracker } from "./StoryTracker";
import type { Goal, GraphSummaryResponse, PlannerWeights } from "../api/types";

const DEFAULT_WEIGHTS: PlannerWeights = { task: 1, xp: 0.15, criticality: 0.4, mapCost: {} };

interface TaskHit {
  id: string;
  name: string;
}

/** Sliders cover the persistent maps players actually weight. */
const WEIGHT_MAPS = MAP_REGISTRY.filter((m) =>
  [
    "factory",
    "customs",
    "woods",
    "lighthouse",
    "shoreline",
    "reserve",
    "interchange",
    "streets-of-tarkov",
    "the-lab",
    "ground-zero",
  ].includes(m.normalizedName),
);

function goalKey(goal: Goal): string {
  switch (goal.type) {
    case "kappa":
    case "lightkeeper":
      return goal.type;
    case "level":
      return `level:${goal.level}`;
    case "tasks":
      return `tasks:${goal.ids.join(",")}`;
  }
}

export function GoalsView(): ReactNode {
  const { api, goals, refreshGoals, refreshPlan, stateRaw, player, foresight, pushToast } =
    useApp();

  // ---------- editable local copy ----------
  const [draftGoals, setDraftGoals] = useState<Goal[]>([]);
  const [draftWeights, setDraftWeights] = useState<PlannerWeights>(DEFAULT_WEIGHTS);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (goals && !dirty) {
      setDraftGoals(goals.goals ?? []);
      setDraftWeights(goals.weights ?? DEFAULT_WEIGHTS);
    }
  }, [goals, dirty]);

  const has = (type: Goal["type"]): boolean => draftGoals.some((g) => g.type === type);
  const levelGoal = draftGoals.find((g): g is Extract<Goal, { type: "level" }> => g.type === "level");
  const tasksGoal = draftGoals.find((g): g is Extract<Goal, { type: "tasks" }> => g.type === "tasks");

  const toggleGoal = (type: "kappa" | "lightkeeper"): void => {
    setDirty(true);
    setDraftGoals((prev) =>
      prev.some((g) => g.type === type) ? prev.filter((g) => g.type !== type) : [...prev, { type }],
    );
  };

  const setLevelGoal = (level: number | null): void => {
    setDirty(true);
    setDraftGoals((prev) => {
      const rest = prev.filter((g) => g.type !== "level");
      return level && level > 1 ? [...rest, { type: "level", level }] : rest;
    });
  };

  const setTaskIds = (ids: string[]): void => {
    setDirty(true);
    setDraftGoals((prev) => {
      const rest = prev.filter((g) => g.type !== "tasks");
      return ids.length > 0 ? [...rest, { type: "tasks", ids }] : rest;
    });
  };

  const setMapCost = (key: string, cost: number): void => {
    setDirty(true);
    setDraftWeights((prev) => {
      const mapCost = { ...prev.mapCost };
      if (cost === 1) delete mapCost[key];
      else mapCost[key] = cost;
      return { ...prev, mapCost };
    });
  };

  const hateLighthouse = (): void => setMapCost("lighthouse", 4);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.post("/api/goals", { goals: draftGoals, weights: draftWeights });
      setDirty(false);
      pushToast("info", "Goals saved — replanning.");
      await Promise.all([refreshGoals(), refreshPlan()]);
    } catch {
      /* toast pushed by client */
    } finally {
      setSaving(false);
    }
  };

  // ---------- custom task search (optional service extension) ----------
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TaskHit[]>([]);
  const [searchUnsupported, setSearchUnsupported] = useState(false);
  const [manualId, setManualId] = useState("");

  useEffect(() => {
    if (!query || query.length < 2 || searchUnsupported) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/graph/tasks?q=${encodeURIComponent(query)}`);
          if (!res.ok) {
            if (res.status === 404) setSearchUnsupported(true);
            return;
          }
          const body = (await res.json()) as unknown;
          const list = Array.isArray(body)
            ? body
            : ((body as { tasks?: unknown[] })?.tasks ?? []);
          if (!cancelled) {
            setHits(
              list
                .filter(
                  (t): t is TaskHit =>
                    !!t &&
                    typeof (t as TaskHit).id === "string" &&
                    typeof (t as TaskHit).name === "string",
                )
                .slice(0, 8),
            );
          }
        } catch {
          /* search stays empty */
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, searchUnsupported]);

  // ---------- progress ----------
  const [graphSummary, setGraphSummary] = useState(() => readGraphSummary(undefined));
  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<GraphSummaryResponse>("/api/graph/summary");
        setGraphSummary(readGraphSummary(res));
      } catch {
        /* fallback totals remain */
      }
    })();
  }, [api, stateRaw]);

  // foresight warnings surfaced at the very top — irreversibility / trap flags
  // (e.g. the Savior-vs-500M trap) rank above the goal editor by design.
  const rank = (w: (typeof foresight)[number]): number =>
    w.severity === "critical" ? 0 : w.severity === "warning" ? 1 : 2;
  const topForesight = [...foresight].sort((a, b) => rank(a) - rank(b));

  return (
    <div>
      <div className="pagehead">
        <h2>Goals &amp; Foresight</h2>
        <span className="count">what the planner optimizes for</span>
      </div>
      <p className="sub">
        Level {player.level}
        {player.faction ? ` · ${player.faction}` : ""}
        {player.prestige ? ` · prestige ${player.prestige}` : ""} — set the target, and watch the
        irreversible traps before they cost you an ending.
      </p>

      {topForesight.length > 0 ? (
        <div className="foresight-banner">
          <div className="sectionlabel">
            <span className="eyebrow">⚠ Foresight · irreversible decisions &amp; XP-gate stalls ahead</span>
            <span className="rule" />
          </div>
          {topForesight.map((warning, i) => {
            const critical = warning.severity === "critical";
            const consequence =
              warning.consequence ??
              warning.message ??
              (warning.fails ?? [])
                .map((f) => {
                  const tags = [
                    f.kappaRequired ? "Kappa" : null,
                    f.lightkeeperRequired ? "Lightkeeper" : null,
                  ]
                    .filter(Boolean)
                    .join(", ");
                  return tags ? `${f.name} (${tags})` : f.name;
                })
                .join(", ");
            return (
              <div key={i} className={`warning-box${critical ? " critical" : ""}`}>
                <div className="w-kind">
                  {warning.kind || "foresight"}
                  {warning.severity ? ` · ${warning.severity}` : ""}
                </div>
                {warning.completing?.name ? (
                  <>
                    Completing <b>{warning.completing.name}</b> is irreversible.{" "}
                  </>
                ) : null}
                {consequence}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="card-grid">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Active goals</h3>
          <div className="controls-row">
            <button className={has("kappa") ? "primary" : ""} onClick={() => toggleGoal("kappa")}>
              Kappa
            </button>
            <button
              className={has("lightkeeper") ? "primary" : ""}
              onClick={() => toggleGoal("lightkeeper")}
            >
              Lightkeeper
            </button>
            <label>
              Level{" "}
              <input
                type="number"
                min={2}
                max={79}
                style={{ width: 64 }}
                value={levelGoal?.level ?? ""}
                placeholder="—"
                onChange={(e) =>
                  setLevelGoal(e.target.value === "" ? null : Number(e.target.value))
                }
              />
            </label>
          </div>

          <h3>Custom tasks</h3>
          {!searchUnsupported ? (
            <>
              <input
                style={{ width: "100%" }}
                placeholder="Search tasks by name…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {hits.map((hit) => (
                <button
                  key={hit.id}
                  style={{ display: "block", width: "100%", textAlign: "left", marginTop: 6 }}
                  onClick={() => {
                    const ids = new Set(tasksGoal?.ids ?? []);
                    ids.add(hit.id);
                    setTaskIds([...ids]);
                    setQuery("");
                  }}
                >
                  + {hit.name}
                </button>
              ))}
            </>
          ) : (
            <div className="controls-row">
              <input
                placeholder="task id (24-hex)"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
              />
              <button
                onClick={() => {
                  const id = manualId.trim();
                  if (!id) return;
                  const ids = new Set(tasksGoal?.ids ?? []);
                  ids.add(id);
                  setTaskIds([...ids]);
                  setManualId("");
                }}
              >
                Add
              </button>
              <span className="sub" style={{ margin: 0 }}>
                (task search not available on this service build)
              </span>
            </div>
          )}
          {(tasksGoal?.ids ?? []).map((id) => (
            <span key={id} className="badge" style={{ marginRight: 6, marginTop: 6 }}>
              {id.slice(0, 10)}…{" "}
              <button
                style={{ border: "none", background: "none", padding: 0, color: "var(--bad)" }}
                onClick={() => setTaskIds((tasksGoal?.ids ?? []).filter((x) => x !== id))}
              >
                ✕
              </button>
            </span>
          ))}

          <div className="controls-row" style={{ marginTop: 16 }}>
            <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : dirty ? "Save goals + weights" : "Saved"}
            </button>
            <span className="sub" style={{ margin: 0 }}>
              {draftGoals.length === 0 ? "No goals set — plan will be empty." : goalsSummary(draftGoals)}
            </span>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Map weights</h3>
          <p className="sub">
            &gt;1 = avoid, &lt;1 = prefer.{" "}
            <button onClick={hateLighthouse}>Hate Lighthouse</button>
          </p>
          {WEIGHT_MAPS.map((map) => {
            const cost =
              draftWeights.mapCost[map.normalizedName] ?? draftWeights.mapCost[map.id] ?? 1;
            return (
              <div key={map.id} className="slider-row">
                <span>{map.name}</span>
                <input
                  type="range"
                  min={0.25}
                  max={4}
                  step={0.25}
                  value={cost}
                  onChange={(e) => setMapCost(map.normalizedName, Number(e.target.value))}
                />
                <span className="val">×{cost.toFixed(2)}</span>
              </div>
            );
          })}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Progress</h3>
          <ProgressBar
            label="Kappa tasks"
            done={graphSummary.kappa.done}
            total={graphSummary.kappa.total}
            pct={graphSummary.kappa.pct}
          />
          <ProgressBar
            label="Lightkeeper tasks"
            done={graphSummary.lightkeeper.done}
            total={graphSummary.lightkeeper.total}
            pct={graphSummary.lightkeeper.pct}
            tone="info"
          />
          <div className="kv">
            <span className="k">Tasks completed</span>
            <span>{player.completedTasks}</span>
            <span className="k">Tasks failed</span>
            <span>{player.failedTasks}</span>
          </div>
        </div>
      </div>

      <h3>TarkovTracker sync</h3>
      <TrackerSyncCard />

      <h3>Story &amp; endings</h3>
      <StoryTracker />

      {draftGoals.length === 0 && foresight.length === 0 ? (
        <Empty>Pick a goal above to start planning.</Empty>
      ) : null}
    </div>
  );
}

/**
 * M2.7 sync card — paste a tarkovtracker.org token (Settings → API token) to
 * import progress once and enable the debounced background mirror. The token
 * is stored server-side in data/local/config.json, never in the browser.
 */
function TrackerSyncCard(): ReactNode {
  const { api, health, refreshAll, pushToast } = useApp();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const sync = health?.trackerSync ?? null;

  const importToken = async (): Promise<void> => {
    if (!token.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ ok: boolean; tasks: number; level: number | null }>(
        "/api/state/import/tarkovtracker",
        { token: token.trim() },
      );
      pushToast("info", `TarkovTracker imported (${res.tasks} tasks) — background sync is on.`);
      setToken("");
      await refreshAll();
    } catch {
      /* error toast pushed by the api client */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      {sync ? (
        <div className="kv">
          <span className="k">Status</span>
          <span>
            {sync.enabled
              ? `syncing (queued: ${sync.queued})`
              : `paused — ${sync.disabledReason ?? sync.lastError ?? "unknown"}`}
          </span>
          {sync.lastError && sync.enabled ? (
            <>
              <span className="k">Last error</span>
              <span>{sync.lastError}</span>
            </>
          ) : null}
        </div>
      ) : (
        <p className="sub" style={{ marginTop: 0 }}>
          Not connected. Paste your token from tarkovtracker.org → Settings → API token (use the
          one matching this profile&apos;s mode, PVP_/PVE_) to import progress and mirror local
          completions back — this also lights up tarkov.dev and RatScanner interop for free.
        </p>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <input
          type="password"
          placeholder={sync ? "replace token…" : "PVP_…"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ flex: 1 }}
        />
        <button onClick={() => void importToken()} disabled={busy || !token.trim()}>
          {busy ? "Importing…" : sync ? "Replace & re-import" : "Import & enable sync"}
        </button>
      </div>
    </div>
  );
}

function goalsSummary(goals: Goal[]): string {
  return goals
    .map((g) => {
      switch (g.type) {
        case "kappa":
          return "Kappa";
        case "lightkeeper":
          return "Lightkeeper";
        case "level":
          return `Level ${g.level}`;
        case "tasks":
          return `${g.ids.length} custom task(s)`;
      }
    })
    .join(" + ");
}
