import { describe, expect, it } from "vitest";
import {
  MAP_COST_MAX,
  MAP_COST_MIN,
  mapSlug,
  proposeWeights,
  type FingerprintLike,
  type MapOutcomeRow,
} from "../src/weights.js";
import { DEFAULT_WEIGHTS } from "../src/types.js";

const fingerprint = (over: Partial<FingerprintLike> = {}): FingerprintLike => ({
  features: {},
  sampleSizes: { raids: 20, decidedRaids: 16, questEvents: 30, sessions: 5 },
  lowConfidence: false,
  ...over,
});

const row = (over: Partial<MapOutcomeRow> & { map: string }): MapOutcomeRow => ({
  n: 0,
  survived: 0,
  died: 0,
  unknown: 0,
  ...over,
});

describe("learned weights proposer (M4.5) — pure and deterministic", () => {
  it("raises aversion for a map with repeated deaths and abandons, with a rationale", () => {
    const proposal = proposeWeights({
      fingerprint: fingerprint(),
      weights: DEFAULT_WEIGHTS,
      mapOutcomes: [row({ map: "Lighthouse", n: 6, survived: 1, died: 4, unknown: 0, abandoned: 1 })],
    });
    const change = proposal.changes.find((c) => c.key === "mapCost.lighthouse");
    expect(change).toBeDefined();
    expect(change!.to).toBeGreaterThan(change!.from);
    expect(change!.rationale).toMatch(/died or abandoned/);
    expect(change!.rationale).toContain("Lighthouse");
    expect(proposal.proposed.mapCost["lighthouse"]).toBe(change!.to);
    expect(proposal.noChange).toBe(false);
  });

  it("caps map aversion at MAP_COST_MAX even under a 100% bad rate", () => {
    const proposal = proposeWeights({
      fingerprint: fingerprint(),
      weights: { ...DEFAULT_WEIGHTS, mapCost: { lighthouse: 2.8 } },
      mapOutcomes: [row({ map: "lighthouse", n: 10, died: 10 })],
    });
    expect(proposal.proposed.mapCost["lighthouse"]).toBe(MAP_COST_MAX);
  });

  it("never proposes below MAP_COST_MIN for preferred maps", () => {
    const proposal = proposeWeights({
      fingerprint: fingerprint({ features: { map_share_customs: 0.6 } }),
      weights: { ...DEFAULT_WEIGHTS, mapCost: { customs: 0.55 } },
      mapOutcomes: [row({ map: "customs", n: 10, survived: 9, unknown: 1 })],
    });
    expect(proposal.proposed.mapCost["customs"]).toBeGreaterThanOrEqual(MAP_COST_MIN);
  });

  it("lowers cost for a map the player clearly favours and survives on", () => {
    const proposal = proposeWeights({
      fingerprint: fingerprint({ features: { map_share_customs: 0.4 } }),
      weights: DEFAULT_WEIGHTS,
      mapOutcomes: [row({ map: "customs", n: 8, survived: 6, died: 1, unknown: 1 })],
    });
    const change = proposal.changes.find((c) => c.key === "mapCost.customs");
    expect(change).toBeDefined();
    expect(change!.to).toBeLessThan(1);
    expect(change!.rationale).toMatch(/lean into a map/);
  });

  it("ignores maps below the minimum sample size", () => {
    const proposal = proposeWeights({
      fingerprint: fingerprint(),
      weights: DEFAULT_WEIGHTS,
      mapOutcomes: [row({ map: "labs", n: 2, died: 2 })],
    });
    expect(proposal.changes).toHaveLength(0);
    expect(proposal.noChange).toBe(true);
    expect(proposal.proposed).toEqual(DEFAULT_WEIGHTS);
  });

  it("raises the task weight for task-focused play (with rationale)", () => {
    const proposal = proposeWeights({
      fingerprint: fingerprint({ features: { task_focus_ratio: 2.5 } }),
      weights: DEFAULT_WEIGHTS,
      mapOutcomes: [],
    });
    const change = proposal.changes.find((c) => c.key === "task");
    expect(change).toBeDefined();
    expect(change!.to).toBeGreaterThan(change!.from);
    expect(change!.rationale.length).toBeGreaterThan(10);
  });

  it("raises the xp weight for loot/XP-focused play", () => {
    const proposal = proposeWeights({
      fingerprint: fingerprint({ features: { task_focus_ratio: 0.3 } }),
      weights: DEFAULT_WEIGHTS,
      mapOutcomes: [],
    });
    const change = proposal.changes.find((c) => c.key === "xp");
    expect(change).toBeDefined();
    expect(change!.to).toBeGreaterThan(change!.from);
  });

  it("makes no global adjustment on low-confidence fingerprints", () => {
    const proposal = proposeWeights({
      fingerprint: fingerprint({ features: { task_focus_ratio: 3 }, lowConfidence: true }),
      weights: DEFAULT_WEIGHTS,
      mapOutcomes: [],
    });
    expect(proposal.changes).toHaveLength(0);
  });

  it("is deterministic: identical inputs produce byte-identical proposals", () => {
    const input = {
      fingerprint: fingerprint({ features: { map_share_customs: 0.4, task_focus_ratio: 2.5 } }),
      weights: DEFAULT_WEIGHTS,
      mapOutcomes: [
        row({ map: "customs", n: 8, survived: 6, died: 1, unknown: 1 }),
        row({ map: "lighthouse", n: 6, died: 4, abandoned: 1, survived: 1 }),
      ],
    };
    const a = proposeWeights(input);
    const b = proposeWeights(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never mutates the input weights (pure function, never auto-applied)", () => {
    const weights = { ...DEFAULT_WEIGHTS, mapCost: { lighthouse: 1 } };
    const frozen = JSON.stringify(weights);
    proposeWeights({
      fingerprint: fingerprint(),
      weights,
      mapOutcomes: [row({ map: "lighthouse", n: 6, died: 5, survived: 1 })],
    });
    expect(JSON.stringify(weights)).toBe(frozen);
  });

  it("mapSlug matches the insights slug convention", () => {
    expect(mapSlug("Ground Zero")).toBe("ground_zero");
    expect(mapSlug("The Lab")).toBe("the_lab");
    expect(mapSlug("")).toBe("unknown");
  });
});
