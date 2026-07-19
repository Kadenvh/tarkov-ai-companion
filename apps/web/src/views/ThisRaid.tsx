/**
 * This Raid (M5.x live surface) — driven by the WS raid lifecycle events the
 * store already tracks (`raidBanner`) plus GET /api/state. When a raid is in
 * progress it shows the map, mode, a live elapsed timer, the planned objectives
 * for the active map (pulled from the current plan), and the latest in-raid
 * position from the screenshot channel. Otherwise it shows "No raid in
 * progress" plus a summary of the last raid.
 *
 * Degrades gracefully: a missing plan / empty state never white-screens — the
 * view just shows less.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store";
import { mapDisplayName, mapDeepLink, resolveMap } from "../lib/maps";
import { timeAgo } from "../lib/format";
import { Badge, Empty } from "../components/common";
import type { PlannedRaid, PositionPayload } from "../api/types";

/** hh:mm:ss (drops the hours segment under an hour). */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Find the first planned raid whose map matches the active raid's map. */
function objectivesForMap(
  raids: PlannedRaid[] | undefined,
  mapKey: string | undefined,
): PlannedRaid | null {
  if (!raids || !mapKey) return null;
  const target = resolveMap(mapKey)?.id;
  for (const raid of raids) {
    if (raid.map === mapKey) return raid;
    if (target && resolveMap(raid.map)?.id === target) return raid;
  }
  return null;
}

export function ThisRaidView(): ReactNode {
  const { raidBanner, plan, positions, player, health } = useApp();
  const [, force] = useState(0);

  // tick the elapsed clock every second while a raid is live
  const active = raidBanner?.kind === "started";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const history: PositionPayload[] = positions.length > 0 ? positions : player.positions;
  const latest = history[0] ?? null;

  if (!active) {
    const last = raidBanner?.kind === "ended" ? raidBanner : null;
    return (
      <div>
        <div className="pagehead">
          <h2>This Raid</h2>
          <span className="count">live raid state</span>
        </div>
        <p className="sub">
          Follows the raid lifecycle as the service detects it — no raid signal touches the game
          process; state comes from logs and the screenshot channel.
        </p>

        {last ? (
          <div className="card raid-card cat-filler">
            <div className="raid-head">
              <span className="raid-index">LAST RAID</span>
              <span className="raid-map">{last.map ? mapDisplayName(last.map) : "Unknown map"}</span>
              <span className="raid-level">
                {last.outcome ? (
                  <Badge kind={last.outcome === "survived" ? "live" : "down"}>
                    {last.outcome}
                  </Badge>
                ) : null}
              </span>
            </div>
            <p className="sub" style={{ margin: "8px 0 0" }}>
              Ended {timeAgo(last.at)} — the planner has replanned; see <strong>Tonight's Plan</strong>.
            </p>
          </div>
        ) : (
          <Empty>
            No raid in progress. When you deploy, this lights up with the map, a live timer, and
            your objectives for that map. Take an in-game screenshot to drop a position marker.
          </Empty>
        )}
      </div>
    );
  }

  const mapKey = raidBanner?.map;
  const objectiveRaid = objectivesForMap(plan?.raids, mapKey);
  const elapsed = raidBanner ? Date.now() - raidBanner.at : 0;
  const link = latest ? mapDeepLink(latest.map ?? mapKey ?? null) : mapDeepLink(mapKey ?? null);

  return (
    <div>
      <div className="pagehead">
        <h2>This Raid</h2>
        <span className="count">
          <span className="badge live">
            <span className="dot" /> IN RAID
          </span>
        </span>
      </div>
      <p className="sub">Live objectives for the active map, straight from tonight's plan.</p>

      <div className="card live-hero">
        <div className="live-top">
          <span className="badge live">
            <span className="dot live-dot" /> LIVE
          </span>
          <span className="live-map">{mapKey ? mapDisplayName(mapKey) : "Unknown map"}</span>
          <span className="live-clock" aria-label="elapsed">
            {fmtElapsed(elapsed)}
          </span>
        </div>
        <div className="live-meta">
          <div className="stat">
            <span className="k">Mode</span>
            <span className="v">{health?.gameMode ?? "—"}</span>
          </div>
          <div className="stat">
            <span className="k">Started</span>
            <span className="v">{raidBanner ? timeAgo(raidBanner.at) : "—"}</span>
          </div>
          <div className="stat">
            <span className="k">Level</span>
            <span className="v">{player.level}</span>
          </div>
          {latest ? (
            <div className="stat">
              <span className="k">Position</span>
              <span className="v">
                {latest.x.toFixed(0)} · {latest.y.toFixed(0)} · {latest.z.toFixed(0)}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="sectionlabel">
        <span className="eyebrow">Objectives · this map</span>
        <span className="rule" />
      </div>
      {objectiveRaid && objectiveRaid.tasks.length > 0 ? (
        <div className="card">
          <ul className="objective-list">
            {objectiveRaid.tasks.map((task) => (
              <li key={task.id}>
                <span className="tick">▸</span>
                <span>
                  {task.name}
                  {task.anyMap ? (
                    <>
                      {" "}
                      <Badge kind="anymap">any map</Badge>
                    </>
                  ) : null}
                  {task.reasons.length > 0 ? (
                    <div className="note">{task.reasons.join(" · ")}</div>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Empty>
          No planned objectives for {mapKey ? mapDisplayName(mapKey) : "this map"} — extract safe and
          bank the XP. Set goals in <strong>Goals &amp; Foresight</strong> to get map-batched
          objectives here.
        </Empty>
      )}

      {latest ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Latest position</h3>
          <div className="kv">
            <span className="k">Coordinates</span>
            <span>
              <code>
                x {latest.x.toFixed(1)} · y {latest.y.toFixed(1)} · z {latest.z.toFixed(1)}
              </code>{" "}
              <span className="dim">· {timeAgo(Date.parse(latest.ts))}</span>
            </span>
          </div>
          {link ? (
            <p style={{ marginTop: 10 }}>
              <a href={link} target="_blank" rel="noreferrer">
                Open the interactive map ↗
              </a>{" "}
              <span className="dim">— paste the coordinates into its position search.</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
