/**
 * Highlight-index timeline (M7.5) — renders a single raid's notable moments as
 * a clip guide: wall-clock-from-start offsets for ShadowPlay / instant-replay.
 * Kill-level markers await a kills log-parser (out of scope) — see @tac/insights.
 */

import type { ReactNode } from "react";
import { mapDisplayName } from "../lib/maps";
import { Badge } from "./common";
import type { HighlightMarker, HighlightMarkerKind, RaidHighlights } from "../api/types";

const KIND_GLYPH: Record<HighlightMarkerKind, string> = {
  "raid-start": "▶",
  "raid-end": "■",
  "quest-completed": "✓",
  "quest-failed": "✗",
  "quest-started": "•",
  "flea-sale": "₽",
  position: "◎",
};

function markerClass(kind: HighlightMarkerKind): string {
  if (kind === "quest-completed") return "live";
  if (kind === "quest-failed" || kind === "raid-end") return "down";
  return "";
}

export function HighlightTimeline({ raid }: { raid: RaidHighlights }): ReactNode {
  const outcomeBadge =
    raid.outcome === "survived" ? (
      <Badge kind="live">survived</Badge>
    ) : raid.outcome === "died" ? (
      <Badge kind="down">died</Badge>
    ) : null;

  return (
    <div className="highlight-raid" style={{ marginBottom: 14 }}>
      <div className="raid-head" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="raid-map">{raid.map ? mapDisplayName(raid.map) : "Unknown map"}</span>
        {outcomeBadge}
        <span className="dim">
          {raid.startedAt ? new Date(raid.startedAt).toLocaleString() : ""}
        </span>
      </div>
      <ul className="objective-list" style={{ marginTop: 6 }}>
        {raid.markers.map((m: HighlightMarker, i) => (
          <li key={`${m.tOffsetSec}-${m.kind}-${i}`}>
            <code style={{ minWidth: 56, display: "inline-block" }}>{m.clock}</code>{" "}
            <span className={`badge ${markerClass(m.kind)}`.trim()}>{KIND_GLYPH[m.kind]}</span>{" "}
            <span>{m.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
