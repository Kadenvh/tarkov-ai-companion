/**
 * Map / position view (M5.5 v1) — latest position from WS `position` events
 * (T1 screenshot channel) with /api/state history as fallback, a position
 * history list, and per-map deep links to tarkov.dev interactive maps.
 * Route overlays are a documented open question (SPEC.md §4.1) — v1 is
 * position + deep link.
 */

import type { ReactNode } from "react";
import { useApp } from "../store";
import { mapDeepLink, mapDisplayName } from "../lib/maps";
import { timeAgo } from "../lib/format";
import { Empty } from "../components/common";
import type { PositionPayload } from "../api/types";

function coord(n: number): string {
  return n.toFixed(1);
}

export function MapView(): ReactNode {
  const { positions, player } = useApp();

  // WS-received positions first (newest first), /api/state history as fallback
  const history: PositionPayload[] = positions.length > 0 ? positions : player.positions;
  const latest = history[0] ?? null;
  const link = latest ? mapDeepLink(latest.map ?? null) : null;

  return (
    <div>
      <h2>Map</h2>
      <p className="sub">
        Position rides the screenshot channel — take an in-game screenshot (default{" "}
        <code>PrtScn</code>) and the marker updates within seconds. Nothing reads the game process.
      </p>

      {!latest ? (
        <Empty>
          No position yet. In raid, press your screenshot key once — EFT encodes your position in
          the screenshot filename, and the watcher picks it up from Documents. That's the only
          in-raid signal this app uses.
        </Empty>
      ) : (
        <div className="card raid-card">
          <div className="raid-head">
            <span className="raid-index">LATEST POSITION</span>
            <span className="raid-map">{mapDisplayName(latest.map ?? null)}</span>
            <span className="raid-level">{timeAgo(Date.parse(latest.ts))}</span>
          </div>
          <div className="kv" style={{ marginTop: 12 }}>
            <span className="k">Coordinates</span>
            <span>
              <code>
                x {coord(latest.x)} · y {coord(latest.y)} · z {coord(latest.z)}
              </code>
            </span>
            {latest.filename ? (
              <>
                <span className="k">Screenshot</span>
                <span className="dim" style={{ wordBreak: "break-all" }}>
                  {latest.filename}
                </span>
              </>
            ) : null}
          </div>
          {link ? (
            <p style={{ marginTop: 12 }}>
              <a href={link} target="_blank" rel="noreferrer">
                Open {mapDisplayName(latest.map ?? null)} on tarkov.dev ↗
              </a>{" "}
              <span className="dim">— paste the coordinates into the map's position search.</span>
            </p>
          ) : null}
        </div>
      )}

      {history.length > 1 ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Position history</h3>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Map</th>
                  <th className="num">x</th>
                  <th className="num">y</th>
                  <th className="num">z</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 50).map((pos, i) => {
                  const deep = mapDeepLink(pos.map ?? null);
                  return (
                    <tr key={`${pos.ts}:${i}`}>
                      <td>{timeAgo(Date.parse(pos.ts))}</td>
                      <td>{mapDisplayName(pos.map ?? null)}</td>
                      <td className="num">{coord(pos.x)}</td>
                      <td className="num">{coord(pos.y)}</td>
                      <td className="num">{coord(pos.z)}</td>
                      <td>
                        {deep ? (
                          <a href={deep} target="_blank" rel="noreferrer">
                            map ↗
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
