/**
 * Environment (M6 surface) — settings diff vs curated profiles with safe
 * apply (409 "game running" handled inline), NVIDIA advisor card, per-map
 * perf percentiles + regression badges, ammo tier lookup by caliber.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store";
import { ApiError } from "../api/client";
import { readPerfRows, readSettingsDiffs } from "../lib/normalize";
import { mapDisplayName } from "../lib/maps";
import { Badge, Empty } from "../components/common";
import type {
  AmmoEntry,
  AmmoResponse,
  ApplyResultResponse,
  EnvironmentSettingsResponse,
  NvidiaReportResponse,
  PerfResponse,
  SettingDiff,
} from "../api/types";

const COMMON_CALIBERS = [
  "5.56x45",
  "5.45x39",
  "7.62x39",
  "7.62x51",
  "7.62x54R",
  "9x19",
  "9x39",
  "12.7x55",
  "12/70",
  ".338",
  ".45",
  "4.6x30",
  "5.7x28",
];

function fmtValue(v: SettingDiff["current"]): string {
  if (v === undefined || v === null) return "—";
  return String(v);
}

export function EnvironmentView(): ReactNode {
  const { api, pushToast } = useApp();

  // ---------- settings diffs ----------
  const [profiles, setProfiles] = useState<Record<string, SettingDiff[]>>({});
  const [activeProfile, setActiveProfile] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [gameRunning, setGameRunning] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const loadSettings = async (): Promise<void> => {
    try {
      const res = await api.get<EnvironmentSettingsResponse>("/api/environment/settings");
      const diffs = readSettingsDiffs(res);
      setProfiles(diffs);
      const keys = Object.keys(diffs);
      setActiveProfile((prev) => (prev && diffs[prev] ? prev : (keys[0] ?? "")));
    } catch {
      /* view shows empty state */
    } finally {
      setSettingsLoaded(true);
    }
  };

  const applyProfile = async (): Promise<void> => {
    if (!activeProfile) return;
    setApplying(true);
    setGameRunning(false);
    try {
      const res = await api.post<ApplyResultResponse>("/api/environment/settings/apply", {
        profile: activeProfile,
      });
      pushToast(
        "info",
        `Applied "${activeProfile}"${res.backupId ? ` — backup ${res.backupId}` : ""}.`,
        "Settings applied",
      );
      await loadSettings();
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) {
        setGameRunning(true); // handled inline, no toast
      }
      /* other errors already toasted by the client */
    } finally {
      setApplying(false);
    }
  };

  // ---------- nvidia / perf ----------
  const [nvidia, setNvidia] = useState<NvidiaReportResponse | null>(null);
  const [perf, setPerf] = useState<ReturnType<typeof readPerfRows>>([]);

  useEffect(() => {
    void loadSettings();
    void api
      .get<NvidiaReportResponse>("/api/environment/nvidia")
      .then(setNvidia)
      .catch(() => undefined);
    void api
      .get<PerfResponse>("/api/environment/perf")
      .then((res) => setPerf(readPerfRows(res)))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // ---------- ammo lookup ----------
  const [caliber, setCaliber] = useState("");
  const [ammo, setAmmo] = useState<AmmoEntry[]>([]);
  const [ammoLoading, setAmmoLoading] = useState(false);

  const lookupAmmo = async (cal: string): Promise<void> => {
    setCaliber(cal);
    if (!cal) {
      setAmmo([]);
      return;
    }
    setAmmoLoading(true);
    try {
      const res = await api.get<AmmoResponse>("/api/environment/ammo", { caliber: cal });
      const list = Array.isArray(res) ? res : (res.table ?? res.ammo ?? []);
      setAmmo(list);
    } catch {
      setAmmo([]);
    } finally {
      setAmmoLoading(false);
    }
  };

  const diffs = profiles[activeProfile] ?? [];

  return (
    <div>
      <div className="pagehead">
        <h2>Settings &amp; Perf</h2>
        <span className="count">around the game · never in it</span>
      </div>
      <p className="sub">
        Settings, driver, and performance around the game — never touching the game process.
        Settings writes only happen with the game closed, after a backup.
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>EFT settings vs curated profiles</h3>
        {Object.keys(profiles).length === 0 ? (
          <Empty>
            {settingsLoaded
              ? "No settings diffs available — the service may not have located the EFT settings files."
              : "Loading settings…"}
          </Empty>
        ) : (
          <>
            <div className="controls-row">
              <label>
                Profile{" "}
                <select value={activeProfile} onChange={(e) => setActiveProfile(e.target.value)}>
                  {Object.keys(profiles).map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary"
                disabled={applying || diffs.length === 0}
                onClick={() => void applyProfile()}
              >
                {applying
                  ? "Applying…"
                  : diffs.length === 0
                    ? "Nothing to apply"
                    : `Apply ${diffs.length} change(s) (game closed only)`}
              </button>
            </div>
            {gameRunning ? (
              <div className="warning-box">
                <div className="w-kind">game running</div>
                Escape from Tarkov is currently running — settings are only written while the game
                is closed. Close the game and try again. Nothing was changed.
              </div>
            ) : null}
            {diffs.length === 0 ? (
              <p className="sub">Your settings already match this profile.</p>
            ) : (
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Setting</th>
                      <th>Current</th>
                      <th>Recommended</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((diff) => (
                      <tr key={diff.key}>
                        <td>
                          <code>{diff.key}</code>
                        </td>
                        <td>{fmtValue(diff.current)}</td>
                        <td>
                          <strong>{fmtValue(diff.recommended)}</strong>
                        </td>
                        <td className="dim">{diff.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <div className="card-grid">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>NVIDIA</h3>
          {!nvidia ? (
            <Empty>No NVIDIA report (nvidia-smi not detected or service unreachable).</Empty>
          ) : (
            <>
              {nvidia.gpu ? (
                <div className="kv" style={{ marginBottom: 10 }}>
                  <span className="k">GPU</span>
                  <span>{nvidia.gpu.name}</span>
                  <span className="k">Driver</span>
                  <span>{nvidia.gpu.driverVersion}</span>
                  <span className="k">VRAM</span>
                  <span>{Math.round(nvidia.gpu.vramMiB / 1024)} GiB</span>
                </div>
              ) : (
                <p className="sub">No NVIDIA GPU detected — generic guidance below.</p>
              )}
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Where</th>
                      <th>Setting</th>
                      <th>Recommended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nvidia.recommendations.map((rec, i) => (
                      <tr key={i} title={rec.why}>
                        <td className="dim">{rec.surface}</td>
                        <td>{rec.setting}</td>
                        <td>
                          <strong>{rec.recommended}</strong>
                          <div className="dim" style={{ fontSize: 13 }}>
                            {rec.why}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Performance per map</h3>
          {perf.length === 0 ? (
            <Empty>
              No frame telemetry yet. Run PresentMon during a session and the service ingests the
              CSV — percentiles land here per map.
            </Empty>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Map</th>
                    <th className="num">FPS avg</th>
                    <th className="num">1% low</th>
                    <th className="num">p95 ft</th>
                    <th className="num">p99 ft</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {perf.map((row, i) => (
                    <tr key={row.map ?? i}>
                      <td>{mapDisplayName(row.map)}</td>
                      <td className="num">{row.fps_avg?.toFixed(0) ?? "—"}</td>
                      <td className="num">{row.fps_p1?.toFixed(0) ?? "—"}</td>
                      <td className="num">{row.frametime_p95?.toFixed(1) ?? "—"}</td>
                      <td className="num">{row.frametime_p99?.toFixed(1) ?? "—"}</td>
                      <td>
                        {row.regressed ? (
                          <span title={(row.regression?.reasons ?? []).join("; ")}>
                            <Badge kind="down">regressed</Badge>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Ammo tiers</h3>
        <div className="controls-row">
          <label>
            Caliber{" "}
            <input
              list="calibers"
              value={caliber}
              placeholder="e.g. 5.45x39"
              onChange={(e) => void lookupAmmo(e.target.value)}
            />
          </label>
          <datalist id="calibers">
            {COMMON_CALIBERS.map((cal) => (
              <option key={cal} value={cal} />
            ))}
          </datalist>
          {ammoLoading ? <span className="sub">loading…</span> : null}
        </div>
        {ammo.length === 0 ? (
          caliber ? (
            <Empty>No ammo found for "{caliber}".</Empty>
          ) : (
            <p className="sub">Pick a caliber to see the current-patch tier table.</p>
          )
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Round</th>
                  <th className="num">Pen</th>
                  <th className="num">Damage</th>
                  <th className="num">Frag</th>
                  <th className="num">Velocity</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {ammo.map((round) => (
                  <tr key={round.id}>
                    <td>
                      <Badge kind="tier">{round.tier}</Badge>
                    </td>
                    <td>{round.shortName || round.name}</td>
                    <td className="num">{round.penetration}</td>
                    <td className="num">
                      {round.projectileCount > 1
                        ? `${round.damage}×${round.projectileCount}`
                        : round.totalDamage}
                    </td>
                    <td className="num">{Math.round(round.fragmentationChance * 100)}%</td>
                    <td className="num">{round.initialSpeedMps} m/s</td>
                    <td className="dim">
                      {[round.fleaBanned ? "flea-banned" : null, round.tracer ? "tracer" : null]
                        .filter(Boolean)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
