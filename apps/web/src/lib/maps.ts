/**
 * Static map registry — tarkov.dev 24-hex map ids from the committed
 * 1.0.6.0.46010 snapshot (data/snapshots/1.0.6.0.46010/regular/maps.json.gz),
 * with display names + tarkov.dev normalizedName for deep links.
 *
 * The planner emits map IDS (PlannedRaid.map); the log/screenshot pipeline may
 * emit BSG nameIds ("bigmap") or display names ("Customs"). This module
 * resolves all three. Unknown keys degrade to a readable fallback — a patch
 * that adds a map must never crash the UI.
 */

export interface MapInfo {
  id: string;
  name: string;
  normalizedName: string;
  /** BSG internal location id as seen in logs/screens (lowercased for lookup) */
  nameId: string;
}

export const MAP_REGISTRY: MapInfo[] = [
  { id: "55f2d3fd4bdc2d5f408b4567", name: "Factory", normalizedName: "factory", nameId: "factory4_day" },
  { id: "59fc81d786f774390775787e", name: "Night Factory", normalizedName: "night-factory", nameId: "factory4_night" },
  { id: "56f40101d2720b2a4d8b45d6", name: "Customs", normalizedName: "customs", nameId: "bigmap" },
  { id: "5704e3c2d2720bac5b8b4567", name: "Woods", normalizedName: "woods", nameId: "woods" },
  { id: "5704e4dad2720bb55b8b4567", name: "Lighthouse", normalizedName: "lighthouse", nameId: "lighthouse" },
  { id: "5704e554d2720bac5b8b456e", name: "Shoreline", normalizedName: "shoreline", nameId: "shoreline" },
  { id: "5704e5fad2720bc05b8b4567", name: "Reserve", normalizedName: "reserve", nameId: "rezervbase" },
  { id: "5714dbc024597771384a510d", name: "Interchange", normalizedName: "interchange", nameId: "interchange" },
  { id: "5714dc692459777137212e12", name: "Streets of Tarkov", normalizedName: "streets-of-tarkov", nameId: "tarkovstreets" },
  { id: "5b0fc42d86f7744a585f9105", name: "The Lab", normalizedName: "the-lab", nameId: "laboratory" },
  { id: "653e6760052c01c1c805532f", name: "Ground Zero", normalizedName: "ground-zero", nameId: "sandbox" },
  { id: "65b8d6f5cdde2479cb2a3125", name: "Ground Zero (21+)", normalizedName: "ground-zero-21", nameId: "sandbox_high" },
  { id: "68236e8153654e8c1200798a", name: "Ground Zero (Tutorial)", normalizedName: "ground-zero-tutorial", nameId: "sandbox_start" },
  { id: "6733700029c367a3d40b02af", name: "The Labyrinth", normalizedName: "the-labyrinth", nameId: "labyrinth" },
  { id: "6925a2c38bdebd9e2302692e", name: "Terminal", normalizedName: "terminal", nameId: "terminal_ui" },
  { id: "69af492a4819ea4ba10a69c5", name: "Icebreaker", normalizedName: "icebreaker", nameId: "icebreaker" },
];

const byId = new Map(MAP_REGISTRY.map((m) => [m.id, m]));
const byNormalized = new Map(MAP_REGISTRY.map((m) => [m.normalizedName, m]));
const byNameId = new Map(MAP_REGISTRY.map((m) => [m.nameId, m]));
const byName = new Map(MAP_REGISTRY.map((m) => [m.name.toLowerCase(), m]));

/** Resolve any map key (id / normalizedName / nameId / display name). */
export function resolveMap(key: string | null | undefined): MapInfo | null {
  if (!key) return null;
  const k = key.trim();
  return (
    byId.get(k) ??
    byNormalized.get(k.toLowerCase()) ??
    byNameId.get(k.toLowerCase()) ??
    byName.get(k.toLowerCase()) ??
    null
  );
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (w === "of" || w === "the" ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/^the /, "The ")
    .replace(/^of /, "Of ");
}

/** Display name for any map key; "Any map" for the planner's "any"; readable fallback. */
export function mapDisplayName(key: string | null | undefined): string {
  if (!key) return "(unknown)";
  if (key === "any") return "Any map";
  const info = resolveMap(key);
  if (info) return info.name;
  // 24-hex id we don't know (new patch): show a short handle, not a wall of hex
  if (/^[0-9a-f]{24}$/i.test(key)) return `map ${key.slice(0, 6)}…`;
  return titleCase(key);
}

/** tarkov.dev interactive map deep link, or null when the map can't be resolved. */
export function mapDeepLink(key: string | null | undefined): string | null {
  const info = resolveMap(key ?? null);
  if (!info) return null;
  return `https://tarkov.dev/map/${info.normalizedName}`;
}

/**
 * Map Genie slugs where they differ from tarkov.dev normalizedNames
 * (every slug probed live 2026-07-11; maps without a Map Genie page → null).
 */
const MAPGENIE_SLUGS: Record<string, string | null> = {
  "the-lab": "lab",
  "streets-of-tarkov": "streets",
  "the-labyrinth": "labyrinth",
  "night-factory": "factory",
  "ground-zero-21": "ground-zero",
  "ground-zero-tutorial": "ground-zero",
  terminal: null,
  icebreaker: null,
};

/** Map Genie deep link (user's Pro session lives in their browser), or null. */
export function mapGenieLink(key: string | null | undefined): string | null {
  const info = resolveMap(key ?? null);
  if (!info) return null;
  const slug =
    info.normalizedName in MAPGENIE_SLUGS ? MAPGENIE_SLUGS[info.normalizedName] : info.normalizedName;
  return slug ? `https://mapgenie.io/tarkov/maps/${slug}` : null;
}
