/**
 * @tier T0 (pure data: reads the committed tarkov.dev snapshot; no game files).
 *
 * M6.4 meta feed: ammo tier table from the real per-patch snapshot. Consumed
 * by agent briefings ("bring M855A1 or better for this batch") and the
 * environment UI.
 */
import {
  latestSnapshot,
  loadRaw,
  loadStrings,
  tr,
  type SnapshotRef,
} from "@tac/data-core";
import type { GameMode } from "@tac/shared";

/**
 * Tier by penetration power. Community ammo charts (tarkov.dev/ammo, EFT wiki
 * ballistics) group by "highest armor class the round reliably defeats"; a
 * round needs pen ≈ 10x the armor class plus margin to kill through it before
 * running dry. Post-1.0 plate hitboxes keep the same ordering. Thresholds:
 *   S ≥54 (class 6) · A ≥47 (class 5+) · B ≥40 (class 4/5) · C ≥33 (class 4)
 *   D ≥26 (class 3) · E ≥20 (class 2/3) · F <20 (flesh/legs only)
 */
export type AmmoTier = "S" | "A" | "B" | "C" | "D" | "E" | "F";

export function classifyAmmoTier(penetrationPower: number): AmmoTier {
  if (penetrationPower >= 54) return "S";
  if (penetrationPower >= 47) return "A";
  if (penetrationPower >= 40) return "B";
  if (penetrationPower >= 33) return "C";
  if (penetrationPower >= 26) return "D";
  if (penetrationPower >= 20) return "E";
  return "F";
}

export interface AmmoEntry {
  id: string;
  name: string;
  shortName: string;
  /** BSG caliber key, e.g. "Caliber556x45NATO". */
  caliber: string;
  penetration: number;
  /** Per-projectile damage. */
  damage: number;
  /** Pellets per shot (buckshot > 1). */
  projectileCount: number;
  /** damage x projectileCount — the flesh number that matters for leg-meta/scav rounds. */
  totalDamage: number;
  fragmentationChance: number;
  initialSpeedMps: number;
  tracer: boolean;
  /** True when the item carries tarkov.dev's noFlea type (trader/craft/barter only). */
  fleaBanned: boolean;
  tier: AmmoTier;
}

interface RawAmmoItem {
  id: string;
  name: string;
  shortName: string;
  types?: string[];
  properties?: {
    propertiesType?: string;
    caliber?: string;
    ammoType?: string;
    damage?: number;
    penetrationPower?: number;
    projectileCount?: number;
    fragmentationChance?: number;
    initialSpeed?: number;
    tracer?: boolean;
  };
}

/**
 * Build the full ammo table from a snapshot. Bullets and buckshot only —
 * grenade/flashbang rounds have no pen-tier meaning.
 */
export function buildAmmoTable(mode: GameMode = "regular", ref: SnapshotRef = latestSnapshot()): AmmoEntry[] {
  const raw = loadRaw(ref, mode, "items") as { items: Record<string, RawAmmoItem> };
  const strings = loadStrings(ref, mode, "items");
  const entries: AmmoEntry[] = [];
  for (const item of Object.values(raw.items ?? {})) {
    const p = item.properties;
    if (p?.propertiesType !== "ItemPropertiesAmmo") continue;
    if (p.ammoType !== "bullet" && p.ammoType !== "buckshot") continue;
    const damage = p.damage ?? 0;
    const projectileCount = p.projectileCount ?? 1;
    const penetration = p.penetrationPower ?? 0;
    entries.push({
      id: item.id,
      name: tr(strings, item.name),
      shortName: tr(strings, item.shortName),
      caliber: p.caliber ?? "unknown",
      penetration,
      damage,
      projectileCount,
      totalDamage: damage * projectileCount,
      fragmentationChance: p.fragmentationChance ?? 0,
      initialSpeedMps: p.initialSpeed ?? 0,
      tracer: p.tracer ?? false,
      fleaBanned: item.types?.includes("noFlea") ?? false,
      tier: classifyAmmoTier(penetration),
    });
  }
  return entries.sort((a, b) => a.caliber.localeCompare(b.caliber) || b.penetration - a.penetration);
}

/** Filter one caliber, best pen first. Accepts the BSG key or a loose fragment ("556", "5.56x45"). */
export function ammoByCaliber(table: AmmoEntry[], caliber: string): AmmoEntry[] {
  const needle = caliber.toLowerCase().replaceAll(".", "").replaceAll(" ", "");
  return table
    .filter((a) => a.caliber.toLowerCase().includes(needle))
    .sort((a, b) => b.penetration - a.penetration);
}

/**
 * Briefing helper (M6.4): top-N rounds for a caliber with one-line reasons —
 * the shape the agent drops straight into a pre-raid briefing.
 */
export function topAmmoForBriefing(
  table: AmmoEntry[],
  caliber: string,
  n = 3,
): { entry: AmmoEntry; reason: string }[] {
  return ammoByCaliber(table, caliber)
    .slice(0, n)
    .map((entry) => ({
      entry,
      reason:
        `${entry.shortName}: tier ${entry.tier} (pen ${entry.penetration}, ` +
        `${entry.projectileCount > 1 ? `${entry.totalDamage} total dmg` : `${entry.damage} dmg`})` +
        (entry.fleaBanned ? " — not on flea, source from trader/craft" : ""),
    }));
}
