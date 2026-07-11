import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeApps, tempDir, testApp } from "./helpers.js";

describe("static web hosting (CONTRACTS §6)", () => {
  afterEach(closeApps);

  it("serves the web build at / with SPA fallback for client routes", async () => {
    const staticDir = tempDir("tac-web-");
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>TAC</title><div id=root></div>");
    writeFileSync(join(staticDir, "app.js"), "console.log('tac')");
    const app = await testApp({ staticDir });

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("TAC");

    const asset = await app.inject({ method: "GET", url: "/app.js" });
    expect(asset.statusCode).toBe(200);

    // client-side route -> index.html (SPA fallback)
    const spa = await app.inject({ method: "GET", url: "/goals" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("TAC");
  });

  it("never SPA-falls-back for /api routes: unknown API paths stay 404 JSON", async () => {
    const staticDir = tempDir("tac-web-");
    writeFileSync(join(staticDir, "index.html"), "<!doctype html>ok");
    const app = await testApp({ staticDir });
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("/api/does-not-exist");
  });

  it("404s JSON everywhere when no web build exists", async () => {
    const app = await testApp(); // helper points staticDir at an empty dir
    const res = await app.inject({ method: "GET", url: "/goals" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
  });
});
