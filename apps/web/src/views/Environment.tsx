/**
 * Settings & Perf (M6 surface) restructured into three tabs:
 *   • Live  — real-time system/GPU telemetry (StatTiles + live TimeSeries fed by
 *             the store's rolling telemetry buffer / WS telemetry.sample).
 *   • Perf  — per-map FPS percentile bars, frametime distribution, regression
 *             callouts, and config→outcome attribution before/after bars.
 *   • Settings — the existing advisor: settings diff vs curated profiles with
 *             safe apply (409 handled inline), NVIDIA advisor, ammo tiers.
 * Every panel degrades to an empty state; nothing crashes or flat-lines to zero.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "../store";
import { ApiError } from "../api/client";
import { readAttribution, readAudit, readPerfRows, readSettingsDiffs } from "../lib/normalize";
import { adsMatchCopy, sortFindings } from "../lib/audit";
import { mapDisplayName } from "../lib/maps";
import { pctDelta } from "../components/charts/geometry";
import {
  BarChart,
  Histogram,
  PercentileBars,
  StatTile,
  TimeSeries,
  type BarDatum,
  type TimeSeriesMetric,
} from "../components/charts";
import { Badge, Empty } from "../components/common";
import type {
  AmmoEntry,
  AmmoResponse,
  ApplyResultResponse,
  AttributionResponse,
  AuditResult,
  EnvironmentSettingsResponse,
  HardwareResponse,
  NvidiaReportResponse,
  PerfResponse,
  SettingDiff,
  TelemetrySample,
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

type Tab = "live" | "perf" | "settings";

function fmtValue(v: SettingDiff["current"]): string {
  if (v === undefined || v === null) return "—";
  return String(v);
}

const int = (v: number): string => String(Math.round(v));

// ---------------------------------------------------------------- Live tab

/** Sample ~this many points back for the StatTile delta (context, not noise). */
const DELTA_LOOKBACK = 15;

function LiveTab(): ReactNode {
  const { telemetry, telemetryLoaded } = useApp();

  const times = useMemo(() => telemetry.map((s) => s.ts), [telemetry]);
  const hasGpu = telemetry.some((s) => s.gpu);
  const last: TelemetrySample | undefined = telemetry[telemetry.length - 1];
  const prev = telemetry[Math.max(0, telemetry.length - 1 - DELTA_LOOKBACK)];

  const systemMetrics: TimeSeriesMetric[] = useMemo(
    () => [
      {
        key: "cpu",
        label: "CPU",
        unit: "%",
        hue: "secondary",
        domain: [0, 100],
        values: telemetry.map((s) => s.system.cpuPct),
        format: int,
      },
      {
        key: "ram",
        label: "RAM",
        unit: "%",
        hue: "secondary",
        domain: [0, 100],
        values: telemetry.map((s) =>
          s.system.memTotalMiB > 0 ? (s.system.memUsedMiB / s.system.memTotalMiB) * 100 : null,
        ),
        format: int,
      },
    ],
    [telemetry],
  );

  const gpuMetrics: TimeSeriesMetric[] = useMemo(
    () =>
      hasGpu
        ? [
            {
              key: "util",
              label: "GPU util",
              unit: "%",
              hue: "secondary",
              domain: [0, 100],
              values: telemetry.map((s) => s.gpu?.utilPct ?? null),
              format: int,
            },
            {
              key: "temp",
              label: "GPU temp",
              unit: "°C",
              hue: "secondary",
              values: telemetry.map((s) => s.gpu?.tempC ?? null),
              format: int,
            },
            {
              key: "power",
              label: "GPU power",
              unit: "W",
              hue: "secondary",
              values: telemetry.map((s) => s.gpu?.powerW ?? null),
              format: int,
            },
          ]
        : [],
    [telemetry, hasGpu],
  );

  if (!telemetryLoaded && telemetry.length === 0) {
    return <Empty>Connecting to telemetry…</Empty>;
  }
  if (telemetry.length === 0) {
    return (
      <Empty>
        No telemetry stream. The observability backend (GET /api/telemetry/* + the telemetry.sample
        WS event) isn&apos;t reporting yet — values land here live once it is.
      </Empty>
    );
  }

  const ramPct =
    last && last.system.memTotalMiB > 0
      ? (last.system.memUsedMiB / last.system.memTotalMiB) * 100
      : null;
  const ramPrevPct =
    prev && prev.system.memTotalMiB > 0
      ? (prev.system.memUsedMiB / prev.system.memTotalMiB) * 100
      : null;
  const gib = (mib: number): string => (mib / 1024).toFixed(1);

  return (
    <>
      <div className="tile-grid">
        <StatTile
          label="CPU"
          value={last ? int(last.system.cpuPct) : "—"}
          unit="%"
          {...(last && prev ? { delta: pctDelta(last.system.cpuPct, prev.system.cpuPct) } : {})}
        />
        <StatTile
          label="RAM"
          value={last ? gib(last.system.memUsedMiB) : "—"}
          unit={last ? `/ ${gib(last.system.memTotalMiB)} GiB` : "GiB"}
          {...(ramPct != null && ramPrevPct != null ? { delta: pctDelta(ramPct, ramPrevPct) } : {})}
          sub={ramPct != null ? `${int(ramPct)}% used` : undefined}
        />
        {hasGpu && last?.gpu ? (
          <>
            <StatTile
              label="GPU util"
              value={int(last.gpu.utilPct)}
              unit="%"
              {...(prev?.gpu ? { delta: pctDelta(last.gpu.utilPct, prev.gpu.utilPct) } : {})}
            />
            <StatTile
              label="GPU temp"
              value={int(last.gpu.tempC)}
              unit="°C"
              {...(prev?.gpu ? { delta: pctDelta(last.gpu.tempC, prev.gpu.tempC) } : {})}
            />
            <StatTile
              label="GPU power"
              value={int(last.gpu.powerW)}
              unit="W"
              {...(prev?.gpu ? { delta: pctDelta(last.gpu.powerW, prev.gpu.powerW) } : {})}
            />
            <StatTile
              label="VRAM"
              value={gib(last.gpu.memUsedMiB)}
              unit={`/ ${gib(last.gpu.memTotalMiB)} GiB`}
              sub={`${last.gpu.coreClockMhz} MHz core`}
            />
          </>
        ) : null}
      </div>

      <div className="card">
        <TimeSeries title="System" times={times} metrics={systemMetrics} />
      </div>

      {hasGpu ? (
        <div className="card">
          <TimeSeries title="GPU" times={times} metrics={gpuMetrics} />
        </div>
      ) : (
        <p className="sub">
          No GPU telemetry in this stream — showing CPU/RAM only. GPU util/temp/power appear here
          when the backend reports a <code>gpu</code> block.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Perf tab

function PerfTab({
  perf,
  attribution,
}: {
  perf: ReturnType<typeof readPerfRows>;
  attribution: ReturnType<typeof readAttribution> | null;
}): ReactNode {
  const namedPerf = perf.filter((r) => r.map);
  const [selMap, setSelMap] = useState<string>("");
  const active = namedPerf.find((r) => r.map === selMap) ?? namedPerf[0];

  const fpsBars: BarDatum[] = namedPerf
    .filter((r) => r.fps_avg != null)
    .map((r) => ({
      label: mapDisplayName(r.map),
      value: r.fps_avg as number,
      tone: r.regressed ? "bad" : "default",
      sub: `${r.n ?? "?"} samples${r.regressed ? " · regressed" : ""}`,
    }));

  const regressions = namedPerf.filter((r) => r.regressed);

  return (
    <>
      {namedPerf.length === 0 ? (
        <Empty>
          No frame telemetry yet. Run PresentMon during a session and the service ingests the CSV —
          percentiles land here per map.
        </Empty>
      ) : (
        <>
          <div className="card">
            <BarChart title="Average FPS by map" unit="fps" data={fpsBars} hue="secondary" />
          </div>

          {regressions.length > 0 ? (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>
                Regressions <Badge kind="down">{regressions.length}</Badge>
              </h3>
              <ul className="objective-list">
                {regressions.map((r) => (
                  <li key={r.map}>
                    <span className="tick">▼</span>
                    <span>
                      <strong>{mapDisplayName(r.map)}</strong>{" "}
                      <Badge kind="warn">regressed</Badge>
                      <div className="note">
                        {(r.regression?.reasons ?? []).join("; ") || "below the rolling baseline"}
                      </div>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {active ? (
            <div className="card">
              <div className="controls-row">
                <label>
                  Map{" "}
                  <select value={active.map ?? ""} onChange={(e) => setSelMap(e.target.value)}>
                    {namedPerf.map((r) => (
                      <option key={r.map} value={r.map ?? ""}>
                        {mapDisplayName(r.map)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="card-grid">
                <PercentileBars
                  title={`${mapDisplayName(active.map)} — framerate`}
                  unit="fps"
                  hue="secondary"
                  data={[
                    { label: "avg", value: active.fps_avg },
                    { label: "1% low", value: active.fps_p1 },
                  ]}
                />
                <PercentileBars
                  title={`${mapDisplayName(active.map)} — frametime`}
                  unit="ms"
                  hue="secondary"
                  format={(v) => v.toFixed(1)}
                  data={[
                    { label: "p50", value: active.frametime_p50 },
                    { label: "p95", value: active.frametime_p95 },
                    { label: "p99", value: active.frametime_p99 },
                  ]}
                />
              </div>
              {active.frametimes && active.frametimes.length > 0 ? (
                <div style={{ marginTop: 14 }}>
                  <Histogram
                    title={`${mapDisplayName(active.map)} — frametime distribution`}
                    unit="ms"
                    hue="secondary"
                    values={active.frametimes}
                    format={(v) => v.toFixed(1)}
                  />
                </div>
              ) : (
                <p className="sub" style={{ marginTop: 10 }}>
                  Raw frametime samples not exported for this map — showing percentiles only. The
                  distribution histogram appears when the perf CSV includes per-frame times.
                </p>
              )}
            </div>
          ) : null}
        </>
      )}

      {attribution && attribution.findings.length > 0 ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            Config → outcome <Badge kind="warn">{attribution.findings.length}</Badge>
          </h3>
          <p className="sub">
            Before/after around a recorded config change. Bars are tinted good/bad by direction and
            always labelled; small-n findings are flagged.
          </p>
          <div className="card-grid">
            {attribution.findings.map((f, i) => {
              const improved = f.direction === "up";
              const unit = f.metric === "fps" ? "fps" : "%";
              const scale = f.metric === "survival" ? 100 : 1;
              return (
                <BarChart
                  key={`${f.changeAt}-${f.metric}-${i}`}
                  title={
                    <>
                      {f.label}{" "}
                      {f.confidence === "low" ? <Badge kind="warn">low n</Badge> : null}
                    </>
                  }
                  unit={unit}
                  hue="secondary"
                  height={150}
                  format={(v) => (f.metric === "survival" ? `${Math.round(v)}` : String(Math.round(v)))}
                  data={[
                    { label: "before", value: f.before * scale, sub: `n=${f.nBefore}` },
                    {
                      label: "after",
                      value: f.after * scale,
                      tone: improved ? "good" : "bad",
                      sub: `n=${f.nAfter}`,
                    },
                  ]}
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- Settings tab

const SEV_LABEL = { high: "high", medium: "med", low: "low" } as const;

/** Config Audit — divergences from the competitive meta + on-meta green checks. */
function AuditPanel({
  audit,
  settingsLoaded,
  applying,
  gameRunning,
  applyKeys,
}: {
  audit: AuditResult | null;
  settingsLoaded: boolean;
  applying: boolean;
  gameRunning: boolean;
  applyKeys: (keys?: string[]) => void;
}): ReactNode {
  const findings = audit ? sortFindings(audit.findings) : [];
  const confirmations = audit?.confirmations ?? [];
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Config audit — vs competitive meta</h3>
      <p className="sub">
        Where your live EFT config drifts from the competitive-meta baseline, worst first. There are
        deliberately <strong>no pro presets</strong> here — every &quot;pro settings&quot; page online
        is uncited and usually stale (see <code>docs/research/12-pro-configs.md</code>), so these are
        community <em>meta norms</em>, not any one streamer&apos;s numbers.
      </p>

      {gameRunning ? (
        <div className="warning-box">
          <div className="w-kind">game running</div>
          Escape from Tarkov is running — settings only write while the game is closed. Nothing was
          changed.
        </div>
      ) : null}

      {!audit ? (
        <Empty>
          {settingsLoaded
            ? "Couldn't read the EFT settings files — the audit needs Graphics/PostFx/Game/Sound to compare."
            : "Loading audit…"}
        </Empty>
      ) : findings.length === 0 ? (
        <p className="sub">
          No meta divergences — your visibility, clarity, and audio settings match the baseline.
        </p>
      ) : (
        <>
          <div className="controls-row">
            <button
              className="primary"
              disabled={applying}
              onClick={() => applyKeys()}
              title="Apply every meta fix below in one write (game closed, backup first)"
            >
              {applying ? "Applying…" : `Fix all ${findings.length} (game closed only)`}
            </button>
          </div>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Setting</th>
                  <th>Current</th>
                  <th>Meta</th>
                  <th>Why</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr key={f.key}>
                    <td>
                      <span className={`badge sev-${f.severity}`}>{SEV_LABEL[f.severity]}</span>
                    </td>
                    <td>
                      <code>{f.key}</code>
                    </td>
                    <td>{fmtValue(f.current)}</td>
                    <td>
                      <strong>{fmtValue(f.recommended)}</strong>
                    </td>
                    <td className="dim">{f.why}</td>
                    <td>
                      <button disabled={applying} onClick={() => applyKeys([f.key])}>
                        Apply
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {confirmations.length > 0 ? (
        <div className="audit-checks">
          {confirmations.map((c) => (
            <Badge key={c.key} kind="ok">
              <span title={c.why}>✓ {c.label}</span>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** ADS 1:1 (true-aim) sensitivity helper. */
function SensitivityPanel({ audit }: { audit: AuditResult | null }): ReactNode {
  const s = audit?.sensitivity;
  const copy = s ? adsMatchCopy(s) : null;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>ADS 1:1 sensitivity</h3>
      <p className="sub">
        The community <strong>&quot;1:1 / true aim&quot;</strong> rule-of-thumb: set your ADS coefficient
        to <code>hipfire × √2 (≈1.42)</code> so a hipfire flick and an aimed turn cover the same mouse
        distance. This is <strong>not authoritatively sourced</strong>, is <em>patch-dependent</em>{" "}
        (BSG has changed ADS scaling across wipes), and is best verified in-game with a 360° test.
      </p>
      {!s || s.hipfire === undefined || s.ads === undefined ? (
        <Empty>
          Needs Control.ini (<code>MouseSensitivity</code> + <code>MouseAimingSensitivity</code>) — not
          found or unreadable.
        </Empty>
      ) : (
        <>
          <div className="kv">
            <span className="k">Hipfire</span>
            <span>{s.hipfire}</span>
            <span className="k">ADS (current)</span>
            <span>{s.ads}</span>
            <span className="k">1:1 target</span>
            <span>{s.oneToOneTarget !== undefined ? Math.round(s.oneToOneTarget * 1000) / 1000 : "—"}</span>
            {s.ratio !== undefined ? (
              <>
                <span className="k">Ratio</span>
                <span>{Math.round(s.ratio * 100) / 100}×</span>
              </>
            ) : null}
            {s.optic !== undefined ? (
              <>
                <span className="k">Optic</span>
                <span>{s.optic}</span>
              </>
            ) : null}
          </div>
          {copy ? (
            <p className={`ads-readout ${copy.matched ? "ok" : "warn"}`}>{copy.text}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Hardware-aware perf advice — the two hardware-dependent EFT settings (Only-
 * use-physical-cores + Automatic-RAM-cleaner) answered from DETECTED specs, not
 * asked. These don't fit the meta-divergence audit (the right value depends on
 * the machine), so they get their own concrete on/off + rationale here.
 */
function HardwarePanel({ hardware }: { hardware: HardwareResponse | null }): ReactNode {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Performance settings for your rig</h3>
      {!hardware ? (
        <Empty>Detecting your hardware…</Empty>
      ) : (
        <>
          <p className="sub" style={{ marginTop: 0 }}>
            Detected:{" "}
            <strong>
              {hardware.hardware.physicalCores ?? "?"}
              {hardware.hardware.physicalCores ? " physical" : " physical (est.)"} /{" "}
              {hardware.hardware.logicalCores} logical cores
            </strong>{" "}
            · <strong>{hardware.hardware.totalRamGB} GB RAM</strong>. These two settings depend on
            your machine, so they're advised here rather than in the meta audit.
          </p>
          <ul className="objective-list">
            {hardware.advice.map((a) => (
              <li key={a.key}>
                <span className="tick">{a.recommend === "on" ? "◉" : "○"}</span>
                <span>
                  <strong>{a.label}</strong>:{" "}
                  <span className={`badge ${a.recommend === "on" ? "live" : "anymap"}`}>
                    {a.recommend.toUpperCase()}
                  </span>{" "}
                  {a.confidence === "medium" ? <Badge kind="warn">worth A/B testing</Badge> : null}
                  <div className="note">{a.why}</div>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SettingsTab({
  audit,
  profiles,
  activeProfile,
  setActiveProfile,
  applying,
  gameRunning,
  settingsLoaded,
  applyProfile,
  applyKeys,
  hardware,
  nvidia,
  caliber,
  ammo,
  ammoLoading,
  lookupAmmo,
}: {
  audit: AuditResult | null;
  profiles: Record<string, SettingDiff[]>;
  activeProfile: string;
  setActiveProfile: (p: string) => void;
  applying: boolean;
  gameRunning: boolean;
  settingsLoaded: boolean;
  applyProfile: () => void;
  applyKeys: (keys?: string[]) => void;
  hardware: HardwareResponse | null;
  nvidia: NvidiaReportResponse | null;
  caliber: string;
  ammo: AmmoEntry[];
  ammoLoading: boolean;
  lookupAmmo: (cal: string) => void;
}): ReactNode {
  const diffs = profiles[activeProfile] ?? [];
  return (
    <>
      <AuditPanel
        audit={audit}
        settingsLoaded={settingsLoaded}
        applying={applying}
        gameRunning={gameRunning}
        applyKeys={applyKeys}
      />
      <SensitivityPanel audit={audit} />
      <HardwarePanel hardware={hardware} />

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
              <button className="primary" disabled={applying || diffs.length === 0} onClick={applyProfile}>
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
                Escape from Tarkov is currently running — settings are only written while the game is
                closed. Close the game and try again. Nothing was changed.
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
        <h3 style={{ marginTop: 0 }}>Ammo tiers</h3>
        <div className="controls-row">
          <label>
            Caliber{" "}
            <input
              list="calibers"
              value={caliber}
              placeholder="e.g. 5.45x39"
              onChange={(e) => lookupAmmo(e.target.value)}
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
            <Empty>No ammo found for &quot;{caliber}&quot;.</Empty>
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
    </>
  );
}

// ---------------------------------------------------------------- shell

export function EnvironmentView(): ReactNode {
  const { api, pushToast, wsStatus } = useApp();
  const [tab, setTab] = useState<Tab>("live");

  // ---------- settings diffs + audit ----------
  const [profiles, setProfiles] = useState<Record<string, SettingDiff[]>>({});
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [activeProfile, setActiveProfile] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [gameRunning, setGameRunning] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const loadSettings = async (): Promise<void> => {
    try {
      const res = await api.get<EnvironmentSettingsResponse>("/api/environment/settings");
      const diffs = readSettingsDiffs(res);
      setProfiles(diffs);
      setAudit(readAudit(res));
      const keys = Object.keys(diffs);
      setActiveProfile((prev) => (prev && diffs[prev] ? prev : (keys[0] ?? "")));
    } catch {
      setAudit(null); // view shows empty state
    } finally {
      setSettingsLoaded(true);
    }
  };

  /**
   * Apply a profile via the existing apply route. `keys` narrows it to a subset
   * (the audit's per-finding / fix-all buttons apply the "meta" profile). 409 →
   * game-running banner, inline, nothing changed.
   */
  const applyChanges = async (profile: string, keys?: string[]): Promise<void> => {
    if (!profile) return;
    setApplying(true);
    setGameRunning(false);
    try {
      const body: Record<string, unknown> = { profile };
      if (keys && keys.length > 0) body["keys"] = keys;
      const res = await api.post<ApplyResultResponse>("/api/environment/settings/apply", body);
      pushToast(
        "info",
        `Applied ${res.applied?.length ?? 0} change(s)${res.backupId ? ` — backup ${res.backupId}` : ""}.`,
        "Settings applied",
      );
      await loadSettings();
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) setGameRunning(true);
    } finally {
      setApplying(false);
    }
  };

  // ---------- nvidia / perf / attribution ----------
  const [nvidia, setNvidia] = useState<NvidiaReportResponse | null>(null);
  const [perf, setPerf] = useState<ReturnType<typeof readPerfRows>>([]);
  const [attribution, setAttribution] = useState<ReturnType<typeof readAttribution> | null>(null);
  const [hardware, setHardware] = useState<HardwareResponse | null>(null);

  useEffect(() => {
    void loadSettings();
    void api
      .get<HardwareResponse>("/api/environment/hardware")
      .then(setHardware)
      .catch(() => undefined);
    void api
      .get<NvidiaReportResponse>("/api/environment/nvidia")
      .then(setNvidia)
      .catch(() => undefined);
    void api
      .get<PerfResponse>("/api/environment/perf")
      .then((res) => setPerf(readPerfRows(res)))
      .catch(() => undefined);
    void api
      .get<AttributionResponse>("/api/insights/attribution")
      .then((res) => setAttribution(readAttribution(res)))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // ---------- ammo lookup ----------
  const [caliber, setCaliber] = useState("");
  const [ammo, setAmmo] = useState<AmmoEntry[]>([]);
  const [ammoLoading, setAmmoLoading] = useState(false);

  const lookupAmmo = (cal: string): void => {
    setCaliber(cal);
    if (!cal) {
      setAmmo([]);
      return;
    }
    setAmmoLoading(true);
    void api
      .get<AmmoResponse>("/api/environment/ammo", { caliber: cal })
      .then((res) => setAmmo(Array.isArray(res) ? res : (res.table ?? res.ammo ?? [])))
      .catch(() => setAmmo([]))
      .finally(() => setAmmoLoading(false));
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: "live", label: "Live" },
    { id: "perf", label: "Perf" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div>
      <div className="pagehead">
        <h2>Settings &amp; Perf</h2>
        <span className="count">
          around the game · never in it {wsStatus === "open" ? "· live" : ""}
        </span>
      </div>
      <p className="sub">
        Settings, driver, and performance around the game — never touching the game process.
        Settings writes only happen with the game closed, after a backup.
      </p>

      <div className="tabbar" role="tablist" aria-label="Settings & Perf sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "live" ? <LiveTab /> : null}
      {tab === "perf" ? <PerfTab perf={perf} attribution={attribution} /> : null}
      {tab === "settings" ? (
        <SettingsTab
          audit={audit}
          profiles={profiles}
          activeProfile={activeProfile}
          setActiveProfile={setActiveProfile}
          applying={applying}
          gameRunning={gameRunning}
          settingsLoaded={settingsLoaded}
          applyProfile={() => void applyChanges(activeProfile)}
          applyKeys={(keys) => void applyChanges("meta", keys)}
          hardware={hardware}
          nvidia={nvidia}
          caliber={caliber}
          ammo={ammo}
          ammoLoading={ammoLoading}
          lookupAmmo={lookupAmmo}
        />
      ) : null}
    </div>
  );
}
