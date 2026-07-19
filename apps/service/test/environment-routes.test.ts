import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeApps, tempDir, testApp, writeSettingsFixture, PRESENTMON_CSV } from "./helpers.js";

describe("environment routes (CONTRACTS §5.4)", () => {
  afterEach(closeApps);

  it("GET /api/environment/settings diffs the on-disk settings against all profiles", async () => {
    const settingsDir = tempDir("tac-settings-");
    writeSettingsFixture(settingsDir);
    const app = await testApp({ settingsDir });
    const body = (await app.inject({ method: "GET", url: "/api/environment/settings" })).json();
    expect(body.dir).toBe(settingsDir);
    expect(body.present).toEqual(expect.arrayContaining(["Graphics", "Game", "PostFx"]));
    expect(body.profiles.map((p: { key: string }) => p.key)).toEqual(["max-fps", "balanced", "max-visibility"]);
    // the fixture is deliberately anti-optimal, so every profile has diffs
    expect(body.diffs["max-fps"].length).toBeGreaterThan(5);
    expect(body.diffs["max-fps"][0]).toHaveProperty("why");
  });

  it("POST /api/environment/settings/apply 409s while the game is running (T1-write guard)", async () => {
    const settingsDir = tempDir("tac-settings-");
    writeSettingsFixture(settingsDir);
    const before = readFileSync(join(settingsDir, "Graphics.ini"), "utf8");
    const app = await testApp({ settingsDir, isGameRunning: () => true });
    const res = await app.inject({
      method: "POST",
      url: "/api/environment/settings/apply",
      payload: { profile: "max-fps" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("running");
    // nothing was written
    expect(readFileSync(join(settingsDir, "Graphics.ini"), "utf8")).toBe(before);
  });

  it("POST /api/environment/settings/apply writes after backup when the game is closed", async () => {
    const settingsDir = tempDir("tac-settings-");
    const backupDir = tempDir("tac-backups-");
    writeSettingsFixture(settingsDir);
    const app = await testApp({ settingsDir, backupDir, isGameRunning: () => false });
    const res = await app.inject({
      method: "POST",
      url: "/api/environment/settings/apply",
      payload: { profile: "max-fps" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.backupId).toBeTruthy();
    expect(body.applied.length).toBeGreaterThan(0);
    // the write actually landed
    const graphics = JSON.parse(readFileSync(join(settingsDir, "Graphics.ini"), "utf8"));
    expect(graphics.VSync).toBe(false);
    // the backup preserves the original
    const backedUp = JSON.parse(readFileSync(join(backupDir, body.backupId, "Graphics.ini"), "utf8"));
    expect(backedUp.VSync).toBe(true);
  });

  it("POST /api/environment/settings/apply 400s on an unknown profile", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/environment/settings/apply",
      payload: { profile: "ultra-mega" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/environment/nvidia reports the GPU via the injected runner", async () => {
    const app = await testApp({
      nvidiaRunner: async () => "NVIDIA GeForce RTX 3080, 551.23, 10240 MiB\n",
    });
    const body = (await app.inject({ method: "GET", url: "/api/environment/nvidia" })).json();
    expect(body.gpu.name).toContain("RTX 3080");
    expect(body.gpu.driverVersion).toBe("551.23");
    expect(Array.isArray(body.recommendations)).toBe(true);
  });

  it("GET /api/environment/hardware returns detected specs + on/off perf advice", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/environment/hardware" })).json();
    expect(body.hardware.logicalCores).toBeGreaterThanOrEqual(1);
    expect(body.hardware.totalRamGB).toBeGreaterThan(0);
    // Exactly the two hardware-dependent settings, each a concrete on/off.
    const keys = body.advice.map((a: { key: string }) => a.key).sort();
    expect(keys).toEqual(["AutomaticRamCleaner", "OnlyUsePhysicalCores"]);
    for (const a of body.advice) expect(["on", "off"]).toContain(a.recommend);
  });

  it("POST /api/environment/perf/import ingests a PresentMon CSV; GET /api/environment/perf reads it back", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/environment/perf/import",
      payload: { csv: PRESENTMON_CSV, map: "customs" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.frames).toBe(3); // dwm.exe row excluded
    expect(body.row.map).toBe("customs");
    expect(body.row.fps_avg).toBeGreaterThan(100);

    const perf = (await app.inject({ method: "GET", url: "/api/environment/perf" })).json();
    expect(perf.samples).toBe(1);
    expect(perf.maps).toHaveLength(1);
    expect(perf.maps[0].map).toBe("customs");
    expect(perf.maps[0].regression).toBeNull(); // no baseline yet
  });

  it("POST /api/environment/perf/import 400s on a CSV without EFT frames", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/environment/perf/import",
      payload: { csv: "Application,ProcessID,Dropped,MsBetweenPresents\ndwm.exe,2,0,16.7\n" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/environment/perf/import refuses non-.csv paths (no arbitrary-file-read)", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/environment/perf/import",
      payload: { path: "C:\\Windows\\win.ini" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/\.csv/);
  });

  it("GET /api/environment/ammo filters by caliber from the snapshot", async () => {
    const app = await testApp();
    const all = (await app.inject({ method: "GET", url: "/api/environment/ammo" })).json();
    expect(all.count).toBeGreaterThan(50);
    const filtered = (await app.inject({ method: "GET", url: "/api/environment/ammo?caliber=556x45" })).json();
    expect(filtered.caliber).toBe("556x45");
    expect(filtered.count).toBeGreaterThan(0);
    expect(filtered.count).toBeLessThan(all.count);
    expect(filtered.ammo[0]).toHaveProperty("penetration");
    expect(filtered.ammo[0]).toHaveProperty("tier");
  });
});
