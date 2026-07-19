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

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../store";
import { mapDisplayName, mapDeepLink, resolveMap } from "../lib/maps";
import { timeAgo } from "../lib/format";
import {
  runthroughStatus,
  scavStatus,
  intelCenterCooldown,
  fmtClock,
  DEFAULT_SCAV_COOLDOWN_SEC,
  type IntelLevel,
} from "../lib/raidClock";
import {
  fireAlert,
  playChime,
  unlockAudio,
  getAlertPrefs,
  setAlertPrefs,
  type AlertPrefs,
} from "../lib/alerts";
import { readHighlights } from "../lib/normalize";
import { Badge, Empty } from "../components/common";
import { HighlightTimeline } from "../components/HighlightTimeline";
import type { HighlightsResponse, PlannedRaid, PositionPayload, RaidHighlights } from "../api/types";

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

/**
 * Alerts control — arms the glanceable audio/voice layer (see lib/alerts.ts).
 * Prefs are global (localStorage), so this toggle governs alerts on every view.
 * Enabling is a user gesture → unlocks the AudioContext + plays a confirming
 * chime so you immediately know audio is working (or blocked).
 */
function AlertsControl(): ReactNode {
  const [prefs, setPrefs] = useState<AlertPrefs>(() => getAlertPrefs());

  const update = (next: AlertPrefs): void => {
    setPrefs(next);
    setAlertPrefs(next);
  };

  const toggle = (): void => {
    const next = { ...prefs, enabled: !prefs.enabled };
    if (next.enabled) unlockAudio();
    update(next);
    if (next.enabled) playChime(); // immediate feedback that audio is live
  };

  return (
    <div className="card alerts-control">
      <div className="scav-head">
        <h3 style={{ margin: 0 }}>Alerts</h3>
        <button className={prefs.enabled ? "primary" : ""} onClick={toggle}>
          {prefs.enabled ? "🔔 On" : "🔕 Off"}
        </button>
      </div>
      <p className="sub" style={{ margin: "6px 0 0" }}>
        A chime{prefs.voice ? " + voice" : ""} on raid start/end, run-through cleared, scav ready,
        and coach nudges — glanceable on your second monitor while you're tabbed into the game.
      </p>
      {prefs.enabled ? (
        <div className="scav-controls" style={{ marginTop: 10 }}>
          <label className="scav-intel">
            <input
              type="checkbox"
              checked={prefs.voice}
              onChange={(e) => update({ ...prefs, voice: e.target.checked })}
            />{" "}
            Spoken voice
          </label>
          <button
            onClick={() => {
              unlockAudio();
              fireAlert("Alerts test.", { spoken: "Alerts armed." });
            }}
          >
            Test
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface ScavPrefs {
  startedAt: number | null;
  intel: IntelLevel;
}

const SCAV_KEY = "tac.scav";

function loadScav(): ScavPrefs {
  try {
    const raw = window.localStorage.getItem(SCAV_KEY);
    if (!raw) return { startedAt: null, intel: 0 };
    const p = JSON.parse(raw) as Partial<ScavPrefs>;
    const intel = p.intel === 1 || p.intel === 2 ? p.intel : 0;
    return { startedAt: typeof p.startedAt === "number" ? p.startedAt : null, intel };
  } catch {
    return { startedAt: null, intel: 0 };
  }
}

function saveScav(prefs: ScavPrefs): void {
  try {
    window.localStorage.setItem(SCAV_KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable — the timer just won't persist across reloads
  }
}

/**
 * Scav cooldown timer — the second account-safe monitor signal in-shell. The
 * real remaining time lives in the profile (T4, never read), so this is an
 * opt-in estimate the player starts by hand; Intel Center level trims the base
 * (mirrors apps/monitor). Persists across reloads via localStorage.
 */
function ScavTimer(): ReactNode {
  const [prefs, setPrefs] = useState<ScavPrefs>(() => loadScav());
  const [, force] = useState(0);

  const running = prefs.startedAt !== null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const update = (next: ScavPrefs): void => {
    setPrefs(next);
    saveScav(next);
  };

  const cooldown = intelCenterCooldown(DEFAULT_SCAV_COOLDOWN_SEC, prefs.intel);
  const status = prefs.startedAt !== null ? scavStatus((Date.now() - prefs.startedAt) / 1000, cooldown) : null;

  // Fire the "scav ready" alert exactly once per cooldown (reset on restart).
  const readyFiredRef = useRef(false);
  useEffect(() => {
    readyFiredRef.current = false;
  }, [prefs.startedAt]);
  useEffect(() => {
    if (status?.ready && !readyFiredRef.current) {
      readyFiredRef.current = true;
      fireAlert("Your scav is off cooldown.", { spoken: "Your scav is off cooldown." });
    }
  });

  return (
    <div className={`card scav-card ${status?.ready ? "cleared" : ""}`}>
      <div className="scav-head">
        <h3 style={{ margin: 0 }}>Scav cooldown</h3>
        {status?.ready ? (
          <span className="pill live">
            <span className="dot" /> SCAV READY
          </span>
        ) : null}
      </div>

      {status === null ? (
        <>
          <p className="sub" style={{ margin: "6px 0 10px" }}>
            An estimate you start when your scav goes on cooldown — the true timer lives in your
            profile, which this app never reads. Base {Math.round(DEFAULT_SCAV_COOLDOWN_SEC / 60)} min,
            trimmed by Intel Center.
          </p>
          <div className="scav-controls">
            <label className="scav-intel">
              Intel Center
              <select
                value={prefs.intel}
                onChange={(e) => update({ ...prefs, intel: Number(e.target.value) as IntelLevel })}
              >
                <option value={0}>None</option>
                <option value={1}>Level 1 (~-35%)</option>
                <option value={2}>Level 2+ (~-50%)</option>
              </select>
            </label>
            <button className="primary" onClick={() => update({ ...prefs, startedAt: Date.now() })}>
              Start ({fmtClock(cooldown)})
            </button>
          </div>
        </>
      ) : status.ready ? (
        <div className="scav-controls" style={{ marginTop: 8 }}>
          <span className="rt-note">
            Your scav is off cooldown — <strong>scav out</strong> when you're ready.
          </span>
          <button onClick={() => update({ ...prefs, startedAt: null })}>Reset</button>
        </div>
      ) : (
        <div className="progress" style={{ margin: "6px 0 0" }}>
          <div className="p-head">
            <span className="dim">Ready in — estimate (Intel {prefs.intel || "none"})</span>
            <span className="pct">{fmtClock(status.remainingSec)}</span>
          </div>
          <div className="track">
            <div className="fill" style={{ width: `${Math.round(status.progress * 100)}%` }} />
          </div>
          <div className="scav-controls" style={{ marginTop: 10 }}>
            <button onClick={() => update({ ...prefs, startedAt: null })}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ThisRaidView(): ReactNode {
  const { api, raidBanner, plan, positions, player, health } = useApp();
  const [, force] = useState(0);
  const [lastHighlights, setLastHighlights] = useState<RaidHighlights | null>(null);

  // tick the elapsed clock every second while a raid is live
  const active = raidBanner?.kind === "started";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);

  // Post-raid: pull the most recent raid's highlight timeline (clip guide).
  // Refetches when a raid ends (raidBanner flips) so the debrief is fresh.
  useEffect(() => {
    if (active) return;
    void api
      .get<HighlightsResponse>("/api/insights/highlights?limit=1")
      .then((res) => setLastHighlights(readHighlights(res)[0] ?? null))
      .catch(() => undefined);
  }, [api, active, raidBanner?.at]);

  // Fire the "run-through cleared" alert once per raid (reset when a raid
  // starts). Placed before the early return so the hook order stays stable;
  // runs each tick while active and no-ops until the time criterion is met.
  const rtFiredRef = useRef(false);
  useEffect(() => {
    rtFiredRef.current = false;
  }, [raidBanner?.at]);
  useEffect(() => {
    if (!active || !raidBanner) return;
    if (runthroughStatus((Date.now() - raidBanner.at) / 1000).met && !rtFiredRef.current) {
      rtFiredRef.current = true;
      fireAlert("Run-through cleared — your extract now counts as a survived raid.", {
        spoken: "Run-through cleared. Your extract will count as survived.",
      });
    }
  });

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

        <AlertsControl />
        <ScavTimer />

        {lastHighlights && lastHighlights.markers.length > 1 ? (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Highlight reel — last raid</h3>
            <p className="sub">
              Offsets from raid start — scrub straight to these moments in your ShadowPlay / instant
              replay capture.
            </p>
            <HighlightTimeline raid={lastHighlights} />
          </div>
        ) : null}
      </div>
    );
  }

  const mapKey = raidBanner?.map;
  const objectiveRaid = objectivesForMap(plan?.raids, mapKey);
  const elapsed = raidBanner ? Date.now() - raidBanner.at : 0;
  const runthrough = runthroughStatus(elapsed / 1000);
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

      <div className={`card runthrough-card ${runthrough.met ? "cleared" : ""}`}>
        {runthrough.met ? (
          <>
            <div className="rt-head">
              <span className="pill live">
                <span className="dot" /> SURVIVAL-ELIGIBLE
              </span>
              <span className="rt-note">
                Past the ~{Math.round(runthrough.thresholdSec / 60)}-min window — extract now and it
                counts as a <strong>survived</strong> raid.
              </span>
            </div>
          </>
        ) : (
          <div className="progress" style={{ margin: 0 }}>
            <div className="p-head">
              <span>
                <span className="pill warn">
                  <span className="dot" /> RUN-THROUGH RISK
                </span>{" "}
                Extract before this counts as a <strong>Run Through</strong> — cut rewards &amp; rep,
                not a survival.
              </span>
              <span className="pct">{fmtClock(runthrough.remainingSec)} left</span>
            </div>
            <div className="track">
              <div className="fill info" style={{ width: `${Math.round(runthrough.progress * 100)}%` }} />
            </div>
            <p className="sub" style={{ margin: "8px 0 0" }}>
              Time criterion only — earning ~200+ in-raid XP also clears it, but that needs the game
              process, which this app never touches.
            </p>
          </div>
        )}
      </div>

      <AlertsControl />
      <ScavTimer />

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
