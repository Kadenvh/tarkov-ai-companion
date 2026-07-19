import { afterEach, describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/config.js";
import { closeApps, jsonResponse, testApp, tempDir } from "./helpers.js";

const TWO_PROFILES: ServiceConfig = {
  profiles: [
    { key: "main-regular", label: "Main (PvP)", gameMode: "regular" },
    { key: "main-pve", label: "Main (PvE)", gameMode: "pve" },
  ],
  activeProfile: "main-regular",
};

describe("core routes (CONTRACTS §5.1)", () => {
  afterEach(closeApps);

  it("rejects non-local Host headers (DNS-rebinding guard) but serves localhost", async () => {
    const app = await testApp();
    const evil = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "evil.example.com:3141" },
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error).toMatch(/local-only/);
    const local = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "127.0.0.1:3141" },
    });
    expect(local.statusCode).toBe(200);
  });

  it("widens the Host allowlist when LAN exposure is opted in, still rejecting others", async () => {
    const app = await testApp({
      config: {
        profiles: [{ key: "main-regular", label: "Main (PvP)", gameMode: "regular" }],
        activeProfile: "main-regular",
        lan: { enabled: true, allowHosts: ["streampc"] },
      },
    });
    // Configured LAN host is allowed…
    const stream = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "streampc:3141" },
    });
    expect(stream.statusCode).toBe(200);
    // …localhost still works…
    const local = await app.inject({ method: "GET", url: "/api/health", headers: { host: "localhost:3141" } });
    expect(local.statusCode).toBe(200);
    // …but an unknown host is still refused (now with the LAN-allowlist message).
    const evil = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "evil.example.com:3141" },
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error).toMatch(/LAN allowlist/);
  });

  it("POST /api/sync drives one on-demand pull cycle and reports a summary", async () => {
    // Point at an empty logs dir so the test never ingests a real local EFT install.
    const app = await testApp({ logsDir: tempDir() });
    const res = await app.inject({ method: "POST", url: "/api/sync" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body).toMatchObject({ parsedEvents: 0, quests: 0, fleaSales: 0, raidsEnded: 0 });
    expect(typeof body.lastSyncAt).toBe("string");
  });

  it("GET /api/health reports version, snapshot, profile, and patch sentinel", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.snapshotVersion).toBe(app.tac.snapshotVersion());
    expect(body.profileKey).toBe("main-regular");
    expect(body.gameMode).toBe("regular");
    expect(typeof body.patchDetected).toBe("boolean");
  });

  it("patch sentinel flags a game/snapshot version mismatch in /api/health (M8.2)", async () => {
    const app = await testApp({ detectGameVersionFn: () => "9.9.9.99999" });
    const body = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(body.gameVersion).toBe("9.9.9.99999");
    expect(body.patchDetected).toBe(true);
  });

  it("GET /api/profiles lists profiles + active key", async () => {
    const app = await testApp({ config: structuredClone(TWO_PROFILES) });
    const body = (await app.inject({ method: "GET", url: "/api/profiles" })).json();
    expect(body.profiles).toHaveLength(2);
    expect(body.activeProfile).toBe("main-regular");
  });

  it("POST /api/profiles/select switches the active profile and game mode", async () => {
    const app = await testApp({ config: structuredClone(TWO_PROFILES) });
    const res = await app.inject({
      method: "POST",
      url: "/api/profiles/select",
      payload: { profileKey: "main-pve" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, profileKey: "main-pve", gameMode: "pve" });
    const health = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(health.profileKey).toBe("main-pve");
    expect(health.gameMode).toBe("pve");
  });

  it("POST /api/profiles/select 404s on an unknown profile", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "POST", url: "/api/profiles/select", payload: { profileKey: "nope" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("nope");
  });

  it("GET /api/state dumps the fresh store (level 1, empty tasks, xp estimate)", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/state" })).json();
    expect(body.level).toBe(1);
    expect(body.tasks).toEqual([]);
    expect(body.xp).toHaveProperty("confidence");
    expect(body.xp).toHaveProperty("levelBand");
    expect(body.counts).toEqual({ tasksCompleted: 0, tasksFailed: 0 });
  });

  it("POST /api/state/manual applies partial updates (M2.6) reflected in GET /api/state", async () => {
    const app = await testApp();
    const taskId = Object.keys(app.tac.world().graph.tasks)[0]!;
    const res = await app.inject({
      method: "POST",
      url: "/api/state/manual",
      payload: {
        level: 23,
        faction: "USEC",
        prestige: 1,
        hideout: { "5d388e97081959000a123acf": 2 },
        traders: { "54cb50c76803fa8b248b4571": { level: 3, rep: 0.25 } },
        tasks: { [taskId]: { complete: true } },
      },
    });
    expect(res.statusCode).toBe(200);
    const state = (await app.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.level).toBe(23);
    expect(state.faction).toBe("USEC");
    expect(state.prestige).toBe(1);
    expect(state.hideout).toEqual([expect.objectContaining({ stationId: "5d388e97081959000a123acf", level: 2 })]);
    expect(state.traders).toEqual([expect.objectContaining({ level: 3, rep: 0.25 })]);
    expect(state.counts.tasksCompleted).toBe(1);
  });

  it("POST /api/state/manual 400s on an invalid body", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "POST", url: "/api/state/manual", payload: { level: 999 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("POST /api/state/import/tarkovtracker seeds the store and persists the token (M2.1)", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      expect(String(input)).toContain("tarkovtracker.org");
      return jsonResponse({
        data: {
          tasksProgress: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", complete: true }],
          taskObjectivesProgress: [{ id: "bbbbbbbbbbbbbbbbbbbbbbbb", complete: true, count: 3 }],
          hideoutModulesProgress: [{ id: "5d388e97081959000a123acf-2", complete: true }],
          playerLevel: 17,
          pmcFaction: "BEAR",
        },
      });
    };
    const app = await testApp({ fetchImpl: fakeFetch });
    const res = await app.inject({
      method: "POST",
      url: "/api/state/import/tarkovtracker",
      payload: { token: "tt-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, tasks: 1, objectives: 1, hideoutModules: 1, level: 17 });
    expect(app.tac.store.level).toBe(17);
    expect(app.tac.store.faction).toBe("BEAR");
    expect(app.tac.config.tarkovTrackerToken).toBe("tt-token");
  });

  it("POST /api/state/import/tarkovtracker 502s when the tracker is unreachable", async () => {
    const app = await testApp({
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/state/import/tarkovtracker",
      payload: { token: "tt" },
    });
    expect(res.statusCode).toBe(502);
  });

  it("GET /api/story returns the dataset + per-chapter player status", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/story" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataset.endings).toHaveLength(4);
    expect(body.player.chapters.length).toBeGreaterThan(0);
    expect(body.player.chapters[0]).toMatchObject({ status: "not-started" });
    expect(body.player.endings.possible).toHaveLength(4);
  });

  it("POST /api/story/progress persists stages/decisions and updates reachability", async () => {
    const app = await testApp();
    const story = (await app.inject({ method: "GET", url: "/api/story" })).json();
    const chapter = story.dataset.chapters[0];
    const stageId = chapter.stages[0].id;
    type Option = { id: string; effects: { locksEndings?: string[]; setsOnlyEnding?: string } };
    const locking = (story.dataset.decisions as { id: string; options: Option[] }[])
      .flatMap((d) => d.options.map((o) => ({ decisionId: d.id, option: o })))
      .find(({ option }) => (option.effects.locksEndings?.length ?? 0) > 0 || option.effects.setsOnlyEnding);

    const res = await app.inject({
      method: "POST",
      url: "/api/story/progress",
      payload: {
        stages: { [stageId]: true },
        ...(locking ? { decisions: { [locking.decisionId]: locking.option.id } } : {}),
      },
    });
    expect(res.statusCode).toBe(200);

    const after = (await app.inject({ method: "GET", url: "/api/story" })).json();
    expect(after.player.stages[stageId]).toBe(true);
    const first = after.player.chapters.find((c: { chapterId: string }) => c.chapterId === chapter.id);
    expect(first.status).not.toBe("not-started");
    if (locking) expect(after.player.endings.possible.length).toBeLessThan(4);
  });

  it("GET /api/graph/summary counts kappa/LK remaining", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/graph/summary" })).json();
    expect(body.totalTasks).toBeGreaterThan(100);
    expect(body.kappa.required).toBeGreaterThan(0);
    expect(body.kappa.remaining).toBe(body.kappa.required);
    expect(body.lightkeeper.required).toBeGreaterThan(0);
    expect(body.snapshotVersion).toBe(app.tac.snapshotVersion());
  });
});
