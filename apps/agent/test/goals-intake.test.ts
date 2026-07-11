import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intakeGoals } from "../src/goals-intake.js";
import { MockClient } from "../src/model.js";
import { ServiceClient } from "../src/service.js";
import { startStubService, type StubService } from "./stub-service.js";

let stub: StubService;
let service: ServiceClient;

beforeAll(async () => {
  stub = await startStubService();
  service = new ServiceClient(stub.url);
});
afterAll(async () => {
  await stub.close();
});

describe("NL goals intake (M4.2)", () => {
  it("round-trips the canonical example: Kappa + Savior before prestige, hate Lighthouse", async () => {
    const result = await intakeGoals(new MockClient(), service, "Kappa + Savior before prestige, hate Lighthouse");

    // kappa goal
    expect(result.goals).toContainEqual({ type: "kappa" });
    // lighthouse aversion: mapCost > 1
    expect(result.weights.mapCost["lighthouse"]).toBeGreaterThan(1);
    // story-ending guard note mentioning the ending by name
    expect(result.notes.some((n) => /savior/i.test(n))).toBe(true);
    // defaults preserved
    expect(result.weights.task).toBe(1);
    expect(result.weights.criticality).toBe(0.4);
  });

  it("persists the extraction through the contracted set_goals tool (POST /api/goals)", async () => {
    const before = stub.goalsPosts.length;
    await intakeGoals(new MockClient(), service, "Kappa + Savior before prestige, hate Lighthouse");
    expect(stub.goalsPosts.length).toBe(before + 1);
    expect(stub.goalsPosts.at(-1)).toMatchObject({
      goals: [{ type: "kappa" }],
      weights: { mapCost: { lighthouse: 1.5 } },
    });
  });

  it("extracts level + lightkeeper goals and map preferences (<1 cost)", async () => {
    const result = await intakeGoals(new MockClient(), service, "get to level 40 and lightkeeper, love customs");
    expect(result.goals).toContainEqual({ type: "level", level: 40 });
    expect(result.goals).toContainEqual({ type: "lightkeeper" });
    expect(result.weights.mapCost["customs"]).toBeLessThan(1);
  });

  it("recovers when the first forced tool call fails validation (in-loop retry)", async () => {
    const client = new MockClient({ badFirstForcedCall: true });
    const result = await intakeGoals(client, service, "Kappa please");
    expect(result.goals).toContainEqual({ type: "kappa" });
    // the invalid attempt and the corrected attempt are both recorded
    const emitCalls = result.toolCalls.filter((c) => c.tool === "emit_goals");
    expect(emitCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("reports set_goals in the tool-call trail", async () => {
    const result = await intakeGoals(new MockClient(), service, "Kappa please");
    expect(result.toolCalls.map((c) => c.tool)).toContain("set_goals");
  });
});
