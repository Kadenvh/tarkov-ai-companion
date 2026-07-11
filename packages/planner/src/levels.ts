/** XP curve helpers over tarkov.dev `playerLevels` (79 rows of {level, exp}). */

export interface LevelRow {
  level: number;
  exp: number;
}

export class LevelCurve {
  private readonly rows: LevelRow[];

  constructor(rows: LevelRow[]) {
    this.rows = [...rows].sort((a, b) => a.level - b.level);
    if (this.rows.length === 0) throw new Error("empty level curve");
  }

  /** Cumulative XP required to be AT a level (level 1 = 0). */
  xpForLevel(level: number): number {
    const clamped = Math.max(1, Math.min(level, this.maxLevel));
    return this.rows[clamped - 1]!.exp;
  }

  /** Highest level whose threshold is <= xp. */
  levelForXp(xp: number): number {
    let level = 1;
    for (const row of this.rows) {
      if (xp >= row.exp) level = row.level;
      else break;
    }
    return level;
  }

  get maxLevel(): number {
    return this.rows[this.rows.length - 1]!.level;
  }
}
