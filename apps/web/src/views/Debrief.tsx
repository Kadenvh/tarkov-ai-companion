/**
 * Debrief (M7 surface, formerly "Insights") — your raid journal, quantified and
 * framed as a post-raid after-action review: survival by map/hour/duration,
 * session rhythm, flea income sparkline, and the playstyle fingerprint. Every
 * metric carries the insights package's small-n honesty (n / lowConfidence)
 * inline. Data: GET /api/insights/{raids,economy,fingerprint}.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store";
import {
  readAttribution,
  readHighlights,
  readInsightsEconomy,
  readInsightsRaids,
  readNetWorthGoal,
} from "../lib/normalize";
import { fmtHour, fmtMinutes, fmtNumber, fmtPct, fmtRubles } from "../lib/format";
import { mapDisplayName } from "../lib/maps";
import { Badge, Empty } from "../components/common";
import { BarChart, TimeSeries, type BarDatum, type TimeMarker } from "../components/charts";
import { HighlightTimeline } from "../components/HighlightTimeline";
import type {
  AttributionResponse,
  FingerprintResponse,
  HighlightsResponse,
  InsightsEconomyResponse,
  InsightsRaidsResponse,
  NetWorthGoalResponse,
  ProposeWeightsResponse,
  WeightChange,
} from "../api/types";

function LowN({ low }: { low?: boolean }): ReactNode {
  return low ? <Badge kind="warn">low n</Badge> : null;
}

/** Humanize a proposer weight key ("mapCost.customs" → "Map cost · Customs"). */
function weightLabel(key: string): string {
  if (key.startsWith("mapCost.")) {
    const slug = key.slice("mapCost.".length).replace(/_/g, " ");
    return `Map cost · ${mapDisplayName(slug)}`;
  }
  switch (key) {
    case "task":
      return "Task weight";
    case "xp":
      return "XP weight";
    case "criticality":
      return "Criticality weight";
    default:
      return key;
  }
}

/**
 * Coach adaptation — surfaces the agent's learned-weights proposal (M4.5): a
 * reviewable delta derived from your playstyle fingerprint + journal outcomes.
 * Never auto-applied — every change shows from→to and a plain-English rationale,
 * and nothing is written until you confirm (CONTRACTS §8, human-in-the-loop).
 * Degrades gracefully: a 503 (agent offline) shows a calm note, not an error.
 */
function CoachAdaptation(): ReactNode {
  const { api, pushToast, refreshPlan, refreshGoals } = useApp();
  const [proposal, setProposal] = useState<ProposeWeightsResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  const load = () => {
    setOffline(false);
    return api
      .get<ProposeWeightsResponse>("/api/agent/propose-weights")
      .then((res) => setProposal(res))
      .catch(() => setOffline(true));
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const apply = async (): Promise<void> => {
    if (!proposal || proposal.changes.length === 0) return;
    setApplying(true);
    try {
      await api.post("/api/weights", { weights: proposal.proposed });
      pushToast(
        "info",
        `Applied ${proposal.changes.length} weight change${proposal.changes.length === 1 ? "" : "s"} — replanning.`,
        "Coach tuned",
      );
      setApplied(true);
      await Promise.all([refreshPlan(), refreshGoals(), load()]);
    } catch {
      /* client already toasts the error */
    } finally {
      setApplying(false);
    }
  };

  const changes: WeightChange[] = proposal?.changes ?? [];

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>
        Coach adaptation{" "}
        {changes.length > 0 ? (
          <Badge kind="warn">
            {changes.length} proposed
          </Badge>
        ) : null}
      </h3>
      <p className="sub">
        How the Coach proposes to reweight your plan from your own journal — always your call to
        apply. Feeds directly into Tonight&apos;s Plan.
      </p>

      {offline ? (
        <p className="sub" style={{ marginTop: 10 }}>
          <span className="dim">
            Copilot offline — start the agent (or set <code>ANTHROPIC_API_KEY</code>) and refresh to
            see proposed tuning. Nothing about your plan is blocked.
          </span>
        </p>
      ) : proposal == null ? (
        <p className="sub dim" style={{ marginTop: 10 }}>
          Reading your fingerprint…
        </p>
      ) : changes.length === 0 ? (
        <p className="sub" style={{ marginTop: 10 }}>
          {applied ? "Applied — " : ""}No adjustments proposed. Your current planner weights already
          fit your journaled outcomes{applied ? "." : " (or there aren't enough raids on a map yet)."}
        </p>
      ) : (
        <>
          <ul className="objective-list">
            {changes.map((c) => {
              const up = c.to > c.from;
              return (
                <li key={c.key}>
                  <span className="tick">{up ? "▲" : "▼"}</span>
                  <span>
                    <strong>{weightLabel(c.key)}</strong>{" "}
                    <span className="mono dim">
                      {c.from} → {c.to}
                    </span>
                    <div className="note">{c.rationale}</div>
                  </span>
                </li>
              );
            })}
          </ul>
          <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
            <button className="primary" disabled={applying} onClick={() => void apply()}>
              {applying ? "Applying…" : "Apply proposed weights"}
            </button>
            <span className="sub dim">Writes to your local profile and replans — reversible any time.</span>
          </div>
        </>
      )}
    </div>
  );
}

type GoalProjection = NonNullable<ReturnType<typeof readNetWorthGoal>["goal"]>;

function goalNoun(kind: GoalProjection["kind"]): string {
  return kind === "rubles" ? "roubles" : kind === "level" ? "level" : "tasks";
}

function goalValue(kind: GoalProjection["kind"], v: number): string {
  return kind === "rubles" ? fmtRubles(v) : fmtNumber(v);
}

function GoalEta({ goal }: { goal: GoalProjection }): ReactNode {
  return (
    <div className="kv" style={{ marginTop: 10 }}>
      <span className="k">Goal</span>
      <span>
        {goalValue(goal.kind, goal.target)} {goalNoun(goal.kind)} <LowN low={goal.lowConfidence} />
      </span>
      <span className="k">Progress</span>
      <span>
        {goalValue(goal.kind, goal.current)} now ·{" "}
        {goal.reached ? "reached ✓" : `${goalValue(goal.kind, goal.remaining)} to go`}
      </span>
      {!goal.reached ? (
        <>
          <span className="k">At current pace</span>
          <span>
            {goal.etaDays == null ? (
              <span className="dim">not enough recent pace to project</span>
            ) : (
              <>
                ~{fmtNumber(goal.etaDays)} day{goal.etaDays === 1 ? "" : "s"}
                {goal.etaRaids != null ? ` · ~${fmtNumber(goal.etaRaids)} raids` : ""}
              </>
            )}
          </span>
        </>
      ) : null}
    </div>
  );
}

export function DebriefView(): ReactNode {
  const { api } = useApp();
  const [raids, setRaids] = useState<ReturnType<typeof readInsightsRaids> | null>(null);
  const [economy, setEconomy] = useState<ReturnType<typeof readInsightsEconomy> | null>(null);
  const [fingerprint, setFingerprint] = useState<FingerprintResponse | null>(null);
  const [networth, setNetworth] = useState<ReturnType<typeof readNetWorthGoal> | null>(null);
  const [attribution, setAttribution] = useState<ReturnType<typeof readAttribution> | null>(null);
  const [highlights, setHighlights] = useState<ReturnType<typeof readHighlights> | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const jobs: Promise<void>[] = [
        api
          .get<InsightsRaidsResponse>("/api/insights/raids")
          .then((res) => setRaids(readInsightsRaids(res)))
          .catch(() => undefined),
        api
          .get<InsightsEconomyResponse>("/api/insights/economy")
          .then((res) => setEconomy(readInsightsEconomy(res)))
          .catch(() => undefined),
        api
          .get<FingerprintResponse>("/api/insights/fingerprint")
          .then(setFingerprint)
          .catch(() => undefined),
        // Kappa is this profile's north-star goal — surface its ETA by default.
        api
          .get<NetWorthGoalResponse>("/api/insights/networth?goal=kappa")
          .then((res) => setNetworth(readNetWorthGoal(res)))
          .catch(() => undefined),
        api
          .get<AttributionResponse>("/api/insights/attribution")
          .then((res) => setAttribution(readAttribution(res)))
          .catch(() => undefined),
        api
          .get<HighlightsResponse>("/api/insights/highlights?limit=6")
          .then((res) => setHighlights(readHighlights(res)))
          .catch(() => undefined),
      ];
      await Promise.all(jobs);
      setLoaded(true);
    })();
  }, [api]);

  const rhythm = raids?.rhythm ?? null;

  return (
    <div>
      <div className="pagehead">
        <h2>Debrief</h2>
        <span className="count">after-action review</span>
      </div>
      <p className="sub">
        Your raid journal, quantified — survival, rhythm, economy, and playstyle across every raid
        the service has journaled.
      </p>

      {loaded && !raids?.byMap.length && !rhythm && !economy?.income && !fingerprint ? (
        <Empty>
          No journaled raids yet. Play with the service running (or run a historical backfill from
          the onboarding dialog) and this fills in.
        </Empty>
      ) : null}

      <div className="card-grid">
        {raids && raids.byMap.length > 0 ? (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Survival by map</h3>
            <BarChart
              hue="primary"
              unit="%"
              height={190}
              format={(v) => String(Math.round(v))}
              data={raids.byMap.map(
                (row): BarDatum => ({
                  label: mapDisplayName(row.map),
                  value: (row.survivalRate ?? 0) * 100,
                  sub: `${row.survived}/${row.n} survived${row.lowConfidence ? " · low n" : ""}`,
                  ...(row.lowConfidence ? { tone: "warn" as const } : {}),
                }),
              )}
            />
          </div>
        ) : null}

        {raids && raids.byHour.rows.length > 0 ? (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Survival by hour</h3>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Hour</th>
                    <th className="num">Raids</th>
                    <th className="num">Rate</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {raids.byHour.rows.map((row) => (
                    <tr key={row.hour}>
                      <td>{fmtHour(row.hour)}</td>
                      <td className="num">{row.n}</td>
                      <td className="num">{fmtPct(row.survivalRate)}</td>
                      <td>
                        <LowN low={row.lowConfidence} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {raids && raids.byDuration.rows.length > 0 ? (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Survival by raid length</h3>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Duration</th>
                    <th className="num">Raids</th>
                    <th className="num">Rate</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {raids.byDuration.rows.map((row) => (
                    <tr key={row.bucket}>
                      <td>{row.bucket}</td>
                      <td className="num">{row.n}</td>
                      <td className="num">{fmtPct(row.survivalRate)}</td>
                      <td>
                        <LowN low={row.lowConfidence} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>

      {rhythm ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            Session rhythm <LowN low={rhythm.summary.lowConfidence} />
          </h3>
          <div className="kv" style={{ marginBottom: 12 }}>
            <span className="k">Sessions</span>
            <span>{rhythm.summary.sessionCount}</span>
            <span className="k">Raids / session</span>
            <span>
              {fmtNumber(rhythm.summary.raidsPerSession.median)} median ·{" "}
              {rhythm.summary.raidsPerSession.mean?.toFixed(1) ?? "—"} mean
            </span>
            <span className="k">Session length</span>
            <span>
              {fmtMinutes(rhythm.summary.sessionLengthMin.median)} median ·{" "}
              {fmtMinutes(rhythm.summary.sessionLengthMin.mean)} mean
            </span>
            {rhythm.summary.best ? (
              <>
                <span className="k">Best session</span>
                <span>
                  {fmtPct(rhythm.summary.best.survivalRate)} on{" "}
                  {new Date(rhythm.summary.best.startTs).toLocaleDateString()}
                </span>
              </>
            ) : null}
            {rhythm.summary.worst ? (
              <>
                <span className="k">Worst session</span>
                <span>
                  {fmtPct(rhythm.summary.worst.survivalRate)} on{" "}
                  {new Date(rhythm.summary.worst.startTs).toLocaleDateString()}
                </span>
              </>
            ) : null}
          </div>
          <BarChart
            title="Survival rate by session"
            hue="primary"
            unit="%"
            height={170}
            format={(v) => String(Math.round(v))}
            data={rhythm.sessions.slice(-14).map(
              (s): BarDatum => ({
                label: new Date(s.startTs).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }),
                value: (s.survivalRate ?? 0) * 100,
                sub: `${s.raidCount} raids · ${fmtMinutes(s.lengthMin)}`,
              }),
            )}
          />
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Start</th>
                  <th className="num">Raids</th>
                  <th className="num">Length</th>
                  <th className="num">Survival</th>
                  <th>Maps</th>
                </tr>
              </thead>
              <tbody>
                {rhythm.sessions.slice(-12).map((session) => (
                  <tr key={session.index}>
                    <td>{new Date(session.startTs).toLocaleString()}</td>
                    <td className="num">{session.raidCount}</td>
                    <td className="num">{fmtMinutes(session.lengthMin)}</td>
                    <td className="num">{fmtPct(session.survivalRate)}</td>
                    <td className="dim">{(session.maps ?? []).map(mapDisplayName).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {economy?.income && economy.income.points.length > 0 ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            Flea income ({economy.income.bucket}) <LowN low={economy.income.lowConfidence} />
          </h3>
          <TimeSeries
            title="Cumulative flea income"
            times={economy.income.points.map((_, i) => i)}
            xFormat={(t) => economy.income?.points[Math.round(t)]?.period ?? ""}
            metrics={[
              {
                key: "income",
                label: "Cumulative",
                unit: "₽",
                hue: "primary",
                values: economy.income.points.map((p) => p.cumulative),
                format: (v) => fmtRubles(v),
              },
            ]}
          />
          <div className="kv" style={{ marginTop: 10 }}>
            <span className="k">Total observed</span>
            <span>{fmtRubles(economy.income.totalIncome)}</span>
            <span className="k">Sales</span>
            <span>{economy.income.n}</span>
          </div>
          {economy.netWorth ? (
            <p className="sub" style={{ marginTop: 10 }}>
              Net-worth estimate ({economy.netWorth.method}):{" "}
              {fmtRubles(economy.netWorth.points.at(-1)?.estimatedNetWorth ?? null)} —{" "}
              {economy.netWorth.caveats.join("; ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {networth && (networth.series.length > 0 || networth.goal) ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            Net worth &amp; goal ETA <LowN low={networth.lowConfidence} />
          </h3>
          {networth.series.length > 0 ? (
            <TimeSeries
              title="Net-worth estimate"
              times={networth.series.map((p) => Date.parse(p.day))}
              xFormat={(t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              markers={
                networth.goal && !networth.goal.reached && networth.goal.etaDays != null
                  ? [
                      {
                        t: Date.now() + networth.goal.etaDays * 86_400_000,
                        label: `goal ~${fmtNumber(networth.goal.etaDays)}d`,
                        tone: "kappa",
                      } as TimeMarker,
                    ]
                  : []
              }
              metrics={[
                {
                  key: "nw",
                  label: "Net worth",
                  unit: "₽",
                  hue: "primary",
                  values: networth.series.map((p) => p.estimatedNetWorth),
                  format: (v) => fmtRubles(v),
                },
              ]}
            />
          ) : null}
          <div className="kv" style={{ marginTop: 10 }}>
            <span className="k">Current estimate</span>
            <span>{fmtRubles(networth.currentEstimate)}</span>
          </div>
          {networth.goal ? <GoalEta goal={networth.goal} /> : null}
        </div>
      ) : null}

      {attribution && (attribution.findings.length > 0 || attribution.changes.length > 0) ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            Config → outcome{" "}
            {attribution.findings.length > 0 ? (
              <Badge kind="warn">
                {attribution.findings.length} finding{attribution.findings.length === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </h3>
          {attribution.findings.length > 0 ? (
            <ul className="objective-list">
              {attribution.findings.map((f, i) => (
                <li key={`${f.changeAt}-${f.metric}-${f.scope}-${i}`}>
                  <span className="tick">{f.direction === "down" ? "▼" : "▲"}</span>
                  <span>
                    {f.label}{" "}
                    {f.confidence === "low" ? <Badge kind="warn">low confidence</Badge> : null}
                    <div className="note">
                      n before {f.nBefore} · after {f.nAfter}
                    </div>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">
              No material survival/FPS shifts around your {attribution.changes.length} recorded
              config change{attribution.changes.length === 1 ? "" : "s"} — either nothing moved or
              there aren't enough raids on both sides of a change yet.
            </p>
          )}
          <p className="sub" style={{ marginTop: 10 }}>
            {attribution.note}
          </p>
        </div>
      ) : null}

      {highlights && highlights.length > 0 ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Highlight reel</h3>
          <p className="sub">
            A clip guide for your recent raids — offsets from raid start, ready to scrub to in
            ShadowPlay / instant replay. Kill markers arrive with the kills log-parser.
          </p>
          {highlights.map((h) => (
            <HighlightTimeline key={h.raidId} raid={h} />
          ))}
        </div>
      ) : null}

      {fingerprint ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            Playstyle fingerprint <LowN low={fingerprint.lowConfidence} />
          </h3>
          <p className="sub">
            {fingerprint.sampleSizes.raids} raids · {fingerprint.sampleSizes.sessions} sessions ·{" "}
            {fingerprint.sampleSizes.questEvents} quest events — feeds learned planner weights
            (M4.5), always inspectable.
          </p>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th className="num">Value</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(fingerprint.features).map(([key, value]) => (
                  <tr key={key}>
                    <td>
                      <code>{key}</code>
                    </td>
                    <td className="num">{value}</td>
                    <td className="dim">{fingerprint.explanations[key] ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <CoachAdaptation />
    </div>
  );
}
