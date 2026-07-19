/**
 * Sources & Connectors (M9/M10 surface, CONTRACTS §5.6/§5.7) — a glance-readable
 * health board for the two integration layers:
 *  - Sources: remote data feeds (tarkov.dev JSON, TarkovTracker). Per source:
 *    up/down dot, apiVersion, cache age, quota (reads/writes remaining + reset),
 *    last error. Live-updates on the `source.status` WS frame.
 *  - Connectors: local capability adapters (EFT config, Wootility, manual). Per
 *    connector: health, capabilities, risk-tier badge.
 *
 * Fetches are tolerant (normalize layer) so a partial/empty service response
 * shows an empty state rather than white-screening under the ViewBoundary.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store";
import { readConnectors, readSourceStatuses } from "../lib/normalize";
import { Badge, Empty } from "../components/common";
import { fmtNumber, fmtSeconds, timeAgo } from "../lib/format";
import type {
  ConnectorHealth,
  ConnectorInfo,
  ConnectorsResponse,
  SourceStatusResponse,
  SourceStatusRow,
} from "../api/types";

const HEALTH_BADGE: Record<ConnectorHealth, "live" | "warn" | "down"> = {
  connected: "live",
  stale: "warn",
  missing: "warn",
  error: "down",
};

function upBadge(up: boolean): ReactNode {
  return (
    <Badge kind={up ? "live" : "down"} dot>
      {up ? "up" : "down"}
    </Badge>
  );
}

/** "resets in 3m" from an ISO instant; empty when unknown/past. */
function resetLabel(resetsAt: string | undefined): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt);
  if (Number.isNaN(ms)) return "";
  const deltaSec = (ms - Date.now()) / 1000;
  if (deltaSec <= 0) return "resetting…";
  return `resets in ${fmtSeconds(deltaSec)}`;
}

function quotaCell(row: SourceStatusRow): ReactNode {
  const quota = row.quota;
  if (!quota || (quota.readsRemaining === undefined && quota.writesRemaining === undefined)) {
    return <span className="dim">—</span>;
  }
  const reset = resetLabel(quota.resetsAt);
  return (
    <span>
      {quota.readsRemaining !== undefined ? `${fmtNumber(quota.readsRemaining)} reads` : ""}
      {quota.writesRemaining !== undefined ? ` · ${fmtNumber(quota.writesRemaining)} writes` : ""}
      {reset ? <span className="dim"> · {reset}</span> : null}
    </span>
  );
}

export function SourcesView(): ReactNode {
  const { api, liveSourceStatus } = useApp();
  const [sources, setSources] = useState<SourceStatusRow[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const res = await api.get<SourceStatusResponse>("/api/sources/status");
      setSources(readSourceStatuses(res));
    } catch {
      /* keep last rows; empty state covers the first-load failure */
    }
    try {
      const res = await api.get<ConnectorsResponse>("/api/connectors");
      setConnectors(readConnectors(res));
    } catch {
      /* connectors table shows empty state */
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Merge live WS `source.status` frames over the last fetched rows.
  const mergedSources = sources.map((row) => liveSourceStatus[row.id] ?? row);

  return (
    <div>
      <h2>Sources &amp; Connectors</h2>
      <p className="sub">
        Remote data feeds (read-only, cache- and quota-disciplined) and local capability adapters
        (T0/T1 only — never the game process). Live health, refreshed as the service reports it.
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Sources (remote feeds)</h3>
        {mergedSources.length === 0 ? (
          <Empty>
            {loaded
              ? "No sources reported — the service may not have registered any remote feeds."
              : "Loading sources…"}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Status</th>
                  <th>API</th>
                  <th>Cache age</th>
                  <th>Quota</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {mergedSources.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <code>{row.id}</code>
                      {row.lastFetch ? (
                        <div className="dim" style={{ fontSize: 12.5 }}>
                          fetched {timeAgo(Date.parse(row.lastFetch))}
                        </div>
                      ) : null}
                    </td>
                    <td>{upBadge(row.up)}</td>
                    <td className="dim">{row.apiVersion ?? "—"}</td>
                    <td className="dim">
                      {row.cacheAgeSec !== undefined ? fmtSeconds(row.cacheAgeSec) : "—"}
                    </td>
                    <td>{quotaCell(row)}</td>
                    <td className="dim">
                      {row.lastError ? <span style={{ color: "var(--bad)" }}>{row.lastError}</span> : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Connectors (local adapters)</h3>
        {connectors.length === 0 ? (
          <Empty>
            {loaded
              ? "No connectors registered."
              : "Loading connectors…"}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Connector</th>
                  <th>Health</th>
                  <th>Capabilities</th>
                  <th>Tier</th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <code>{c.id}</code>
                      {c.vendor ? (
                        <div className="dim" style={{ fontSize: 12.5 }}>
                          {c.vendor}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <Badge kind={HEALTH_BADGE[c.health]} dot>
                        {c.health}
                      </Badge>
                    </td>
                    <td className="dim">{c.capabilities.join(", ") || "—"}</td>
                    <td>
                      <Badge kind="tier">{c.riskTier || "—"}</Badge>
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
