import { afterEach, describe, expect, it } from "vitest";
import { closeApps, testApp } from "./helpers.js";

describe("planning routes (CONTRACTS §5.2)", () => {
  afterEach(closeApps);

  it("GET /api/goals defaults to kappa with default weights", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/goals" })).json();
    expect(body.goals).toEqual([{ type: "kappa" }]);
    expect(body.weights).toMatchObject({ task: 1 });
    expect(body.isDefault).toBe(true);
  });

  it("POST /api/goals persists goals + weights; GET reflects them", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/goals",
      payload: {
        goals: [{ type: "level", level: 30 }, { type: "lightkeeper" }],
        weights: { task: 2, xp: 0.5, criticality: 0.1, mapCost: { woods: 1.5 } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = (await app.inject({ method: "GET", url: "/api/goals" })).json();
    expect(body.goals).toEqual([{ type: "level", level: 30 }, { type: "lightkeeper" }]);
    expect(body.weights.mapCost).toEqual({ woods: 1.5 });
    expect(body.isDefault).toBe(false);
  });

  it("POST /api/weights applies weights alone (no goals) and GET reflects them", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/weights",
      payload: { weights: { task: 1.3, xp: 0.2, criticality: 0.1, mapCost: { lighthouse: 1.8 } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, weights: { task: 1.3, mapCost: { lighthouse: 1.8 } } });
    // Goals are untouched — still the default — while weights now reflect the apply.
    const goals = (await app.inject({ method: "GET", url: "/api/goals" })).json();
    expect(goals.goals).toEqual([{ type: "kappa" }]);
    expect(goals.weights.mapCost).toEqual({ lighthouse: 1.8 });
  });

  it("POST /api/weights 400s on a malformed body", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/weights",
      payload: { weights: { task: "lots" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/goals 400s on an unknown goal type", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/goals",
      payload: { goals: [{ type: "world-domination" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/plan builds a hashed plan with per-raid foresight in < 2 s (M3.2)", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/plan?horizon=3" })).json();
    expect(body.horizon).toBe(3);
    expect(body.plan.raids.length).toBeLessThanOrEqual(3);
    expect(body.plan.raids.length).toBeGreaterThan(0);
    expect(body.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(body.buildMs).toBeLessThan(2000);
    // foresight is index-aligned with the planned raids
    expect(body.foresight).toHaveLength(body.plan.raids.length);
    expect(body.foresight[0]).toMatchObject({ raidIndex: body.plan.raids[0].index });
    const raid = body.plan.raids[0];
    expect(raid).toHaveProperty("map");
    expect(raid).toHaveProperty("levelBefore");
    expect(raid).toHaveProperty("levelAfter");
    expect(raid.tasks.length).toBeGreaterThan(0);
    // every raid map id resolves to a display name (consumers never show raw ids)
    expect(body.mapNames).toBeDefined();
    for (const r of body.plan.raids) {
      expect(typeof body.mapNames[r.map]).toBe("string");
      expect(body.mapNames[r.map]).not.toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it("GET /api/plan clamps a garbage horizon to the default", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/plan?horizon=banana" })).json();
    expect(body.horizon).toBe(10);
  });

  it("GET /api/quartermaster returns an AcquisitionPlan (CONTRACTS §7)", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/quartermaster?raids=2" })).json();
    expect(body.raids).toBeLessThanOrEqual(2);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.totalRubles).toBe("number");
    expect(Array.isArray(body.craftSchedule)).toBe(true);
    if (body.items.length > 0) {
      const item = body.items[0];
      expect(item).toHaveProperty("itemId");
      expect(item).toHaveProperty("count");
      expect(item).toHaveProperty("fir");
      expect(item.route).toHaveProperty("kind");
      expect(Array.isArray(item.reasons)).toBe(true);
    }
  });

  it("GET /api/foresight reports pending warnings + story reachability for current goals", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/foresight" })).json();
    expect(body.goals).toEqual([{ type: "kappa" }]);
    expect(body.pendingGoalTasks).toBeGreaterThan(0);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.story.endings.possible).toHaveLength(4);
    expect(Array.isArray(body.story.pendingDecisions)).toBe(true);
  });
});
