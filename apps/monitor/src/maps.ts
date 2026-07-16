/**
 * EFT raw location key (as it appears in raid.map / the logs) → display name
 * and tarkov.dev map id (`normalizedName`, used for crowdsourced submissions).
 *
 * Keys mirror packages/state-engine LOCATION_NAMES. Night Factory and the two
 * Ground Zero tiers collapse to a single tarkov.dev map id — the day/night and
 * level split is carried separately as the queue "type", not the map id.
 * @tier T0
 */

interface MapInfo {
  name: string;
  /** tarkov.dev normalizedName; null when tarkov.dev has no matching map id */
  devId: string | null;
}

const MAPS: Record<string, MapInfo> = {
  factory4_day: { name: "Factory (Day)", devId: "factory" },
  factory4_night: { name: "Factory (Night)", devId: "factory" },
  bigmap: { name: "Customs", devId: "customs" },
  woods: { name: "Woods", devId: "woods" },
  shoreline: { name: "Shoreline", devId: "shoreline" },
  interchange: { name: "Interchange", devId: "interchange" },
  rezervbase: { name: "Reserve", devId: "reserve" },
  laboratory: { name: "The Lab", devId: "the-lab" },
  lighthouse: { name: "Lighthouse", devId: "lighthouse" },
  tarkovstreets: { name: "Streets of Tarkov", devId: "streets-of-tarkov" },
  city: { name: "Streets of Tarkov", devId: "streets-of-tarkov" },
  sandbox: { name: "Ground Zero", devId: "ground-zero" },
  sandbox_high: { name: "Ground Zero (21+)", devId: "ground-zero" },
  labyrinth: { name: "Labyrinth", devId: "the-labyrinth" },
  terminal: { name: "Terminal", devId: null },
};

/** Human-readable map name; falls back to a title-cased key. */
export function mapDisplayName(raw: string | null | undefined): string {
  if (!raw) return "Unknown";
  const key = raw.trim().toLowerCase();
  const info = MAPS[key];
  if (info) return info.name;
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** tarkov.dev map id for crowdsourced submissions; null when unmapped. */
export function tarkovDevMapId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return MAPS[raw.trim().toLowerCase()]?.devId ?? null;
}
