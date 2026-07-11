/**
 * Quartermaster (M5.4) — the pre-session shopping run. Acquisition table
 * grouped by route kind, totals header, craft schedule with startBy, and a
 * per-item "why" expander (reasons + alternatives, M3.6 explainability).
 */

import type { ReactNode } from "react";
import { useApp } from "../store";
import { explainReasons, groupByRoute, planTotals } from "../lib/quartermasterView";
import { fmtMinutes, fmtNumber, fmtRubles } from "../lib/format";
import { Badge, Empty } from "../components/common";
import type { AcquisitionItem, AcquisitionRoute } from "../api/types";

function routeSummary(route: AcquisitionRoute): string {
  const bits: string[] = [route.detail];
  if (route.unitCost) bits.push(`${fmtRubles(route.unitCost)} ea`);
  if (route.levelGate) bits.push(`lvl ${route.levelGate}+`);
  if (route.traderGate) bits.push(route.traderGate);
  if (route.craftStation)
    bits.push(`${route.craftStation}${route.craftMinutes ? ` · ${fmtMinutes(route.craftMinutes)}` : ""}`);
  if (route.kind === "find-in-raid" && route.raidIndex) bits.push(`raid #${route.raidIndex}`);
  return bits.join(" · ");
}

function ItemRow({ item }: { item: AcquisitionItem }): ReactNode {
  const reasons = explainReasons(item);
  return (
    <tr>
      <td>
        <strong>{item.name}</strong> {item.fir ? <Badge kind="fir">FIR</Badge> : null}
        <details className="expander">
          <summary>why</summary>
          <ul>
            {reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
            {item.forTasks.length > 0 ? (
              <li>For: {item.forTasks.map((t) => t.name).join(", ")}</li>
            ) : null}
            {item.alternatives.length > 0 ? (
              <li>
                Alternatives:{" "}
                {item.alternatives.map((alt) => `${alt.kind} (${routeSummary(alt)})`).join("; ")}
              </li>
            ) : null}
          </ul>
        </details>
      </td>
      <td className="num">{item.count}</td>
      <td>{routeSummary(item.route)}</td>
      <td className="num">{item.route.totalCost ? fmtRubles(item.route.totalCost) : "—"}</td>
    </tr>
  );
}

export function QuartermasterView(): ReactNode {
  const { quartermaster, horizon } = useApp();
  const groups = groupByRoute(quartermaster);
  const totals = planTotals(quartermaster);

  return (
    <div>
      <h2>Quartermaster</h2>
      <p className="sub">
        Everything to acquire before the next {totals.raids || horizon} raids — cheapest feasible
        route per item.
      </p>

      {!quartermaster ? (
        <Empty>No acquisition plan yet — set goals and generate a plan first.</Empty>
      ) : (
        <>
          <div className="free-strip">
            <span className="label">Totals</span>
            <span className="chip">{fmtRubles(totals.totalRubles)}</span>
            <span className="chip">{totals.itemLines} lines</span>
            <span className="chip">{fmtNumber(totals.units)} units</span>
            <span className="chip">{totals.firLines} FIR</span>
            <span className="chip">{totals.craftLines} crafts</span>
          </div>

          {groups.length === 0 ? (
            <Empty>Nothing to buy — you're stocked for the plan.</Empty>
          ) : (
            groups.map((group) => (
              <div key={group.kind} className="card">
                <h3 style={{ marginTop: 0 }}>
                  {group.label}{" "}
                  <span className="dim" style={{ textTransform: "none", letterSpacing: 0 }}>
                    — {group.items.length} lines
                    {group.totalRubles > 0 ? ` · ${fmtRubles(group.totalRubles)}` : ""}
                  </span>
                </h3>
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">Count</th>
                        <th>Route</th>
                        <th className="num">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((item) => (
                        <ItemRow key={`${item.itemId}:${item.fir}`} item={item} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}

          {quartermaster.craftSchedule.length > 0 ? (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Craft schedule</h3>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Item</th>
                      <th>Duration</th>
                      <th>Start by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quartermaster.craftSchedule.map((craft, i) => {
                      const item = quartermaster.items.find((x) => x.itemId === craft.itemId);
                      return (
                        <tr key={i}>
                          <td>{craft.station}</td>
                          <td>{item?.name ?? craft.itemId}</td>
                          <td>{fmtMinutes(craft.minutes)}</td>
                          <td>{new Date(craft.startBy).toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
