/**
 * Tonight's Plan (M5.2) — the default, glance-distance view. Raid cards built
 * by lib/planView.ts from GET /api/plan + GET /api/quartermaster; live via
 * WS plan.updated (store refetches) and raid.started/ended (banner in App).
 */

import { useState, type ReactNode } from "react";
import { useApp } from "../store";
import { buildPlanVM, warningText, type RaidCardVM } from "../lib/planView";
import { mapDisplayName } from "../lib/maps";
import { fmtRubles, timeAgo } from "../lib/format";
import { Badge, Empty } from "../components/common";
import type { AcquisitionItem } from "../api/types";

function PrepLine({ item }: { item: AcquisitionItem }): ReactNode {
  const route = item.route;
  const routeText =
    route.kind === "find-in-raid"
      ? `FIR — ${route.detail}`
      : `${route.kind}: ${route.detail}${route.totalCost ? ` (${fmtRubles(route.totalCost)})` : ""}`;
  return (
    <div className="prep-item">
      <span className="count">{item.count}×</span>
      <span>{item.name}</span>
      {item.fir ? <Badge kind="fir">FIR</Badge> : null}
      <span className="route">{routeText}</span>
    </div>
  );
}

function RaidCard({ raid }: { raid: RaidCardVM }): ReactNode {
  return (
    <div className="card raid-card">
      <div className="raid-head">
        <span className="raid-index">RAID {raid.index}</span>
        <span className="raid-map">{raid.mapName}</span>
        <span className="raid-level">
          lvl {raid.levelBefore}
          {raid.levelAfter > raid.levelBefore ? (
            <span className="up"> → {raid.levelAfter}</span>
          ) : null}
        </span>
      </div>

      {raid.tasks.length > 0 ? (
        <ul className="batch">
          {raid.tasks.map((task) => (
            <li key={task.id}>
              {task.name}
              {task.anyMap ? (
                <>
                  {" "}
                  <Badge kind="anymap">any map</Badge>
                </>
              ) : null}
              {task.reasons.length > 0 ? (
                <div className="task-reasons">{task.reasons.join(" · ")}</div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="task-reasons" style={{ marginTop: 10 }}>
          No batched tasks — XP / filler raid.
        </div>
      )}

      {raid.warnings.map((warning, i) => (
        <div
          key={i}
          className={`warning-box${warning.severity === "critical" ? " critical" : ""}`}
        >
          <div className="w-kind">{warning.kind || "foresight"}</div>
          {warningText(warning)}
        </div>
      ))}

      {raid.prep.length > 0 ? (
        <div className="prep-list">
          <div className="prep-title">Prep before this raid</div>
          {raid.prep.map((item) => (
            <PrepLine key={item.itemId} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TonightsPlan(): ReactNode {
  const { plan, quartermaster, planFetchedAt, planStale, refreshPlan, horizon, setHorizon } =
    useApp();
  const [refreshing, setRefreshing] = useState(false);
  const vm = buildPlanVM(plan, quartermaster, (key) => plan?.mapNames?.[key] ?? mapDisplayName(key));

  const doRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refreshPlan();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div>
      <h2>Tonight's Plan</h2>
      <p className="sub">Rolling raid batches toward your goals — replans live on raid end.</p>

      <div className="controls-row">
        <label>
          Horizon{" "}
          <input
            type="number"
            min={1}
            max={20}
            value={horizon}
            style={{ width: 64 }}
            onChange={(e) => setHorizon(Number(e.target.value))}
          />{" "}
          raids
        </label>
        <button onClick={() => void doRefresh()} disabled={refreshing}>
          {refreshing ? "Replanning…" : "Replan now"}
        </button>
        <div className="freshness">
          {planStale ? <span className="stale">STALE — raid ended, replanning…</span> : null}
          {planFetchedAt ? <span>plan from {timeAgo(planFetchedAt)}</span> : null}
          {vm?.hash ? <code>#{vm.hash.slice(0, 8)}</code> : null}
        </div>
      </div>

      {!vm ? (
        <Empty>
          No plan yet. Set goals in the <strong>Goals</strong> view (or check that the service is
          running on port 3141).
        </Empty>
      ) : (
        <>
          {vm.freeTasks.length > 0 ? (
            <div className="free-strip">
              <span className="label">Free before you queue</span>
              {vm.freeTasks.map((task) => (
                <span key={task.id} className="chip">
                  {task.name}
                </span>
              ))}
            </div>
          ) : null}

          {vm.levelStalls.length > 0 ? (
            <div className="free-strip">
              <span className="label">Level gates ahead</span>
              {vm.levelStalls.map((stall) => (
                <span key={stall.taskId} className="chip">
                  {stall.name} @ lvl {stall.requiredLevel}
                </span>
              ))}
            </div>
          ) : null}

          <div className="card-grid">
            {vm.raids.map((raid) => (
              <RaidCard key={raid.index} raid={raid} />
            ))}
          </div>

          {vm.raids.length === 0 ? (
            <Empty>
              Plan is empty — {vm.remainingGoalTasks} goal task(s) remain but none are currently
              actionable. Check level gates and trader levels.
            </Empty>
          ) : (
            <p className="sub" style={{ marginTop: 14 }}>
              {vm.remainingGoalTasks} of {vm.goalTaskCount} goal tasks remaining · plan reaches
              level {vm.reachedLevel}
            </p>
          )}
        </>
      )}
    </div>
  );
}
