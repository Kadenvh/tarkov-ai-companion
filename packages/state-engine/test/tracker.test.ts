import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TarkovTrackerMirror } from "../src/tracker.js";
import { openProfile } from "../src/store.js";

const progressFixture = () =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "tarkovtracker-progress.json"), "utf8")) as unknown;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const mem = () => openProfile("tracker-regular", { memory: true });

describe("TarkovTracker mirror (M2.7) — mocked fetch, no network", () => {
  it("imports GET /progress into the store", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(progressFixture()));
    const store = mem();
    const mirror = new TarkovTrackerMirror(store, { token: "PVP_test", fetchImpl });

    const res = await mirror.importOnce();
    expect(res.ok).toBe(true);
    expect(store.level).toBe(42);
    expect(store.getTask("5936d90786f7742b1420ba5b")).toMatchObject({ complete: true });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tarkovtracker.org/api/v2/progress");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer PVP_test");
  });

  it("batches queued task writes into ONE POST /progress/tasks", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const mirror = new TarkovTrackerMirror(mem(), { token: "PVP_test", fetchImpl, debounceMs: 60_000 });

    mirror.queueTask("aaaaaaaaaaaaaaaaaaaaaaaa", "completed");
    mirror.queueTask("bbbbbbbbbbbbbbbbbbbbbbbb", "failed");
    mirror.queueTask("aaaaaaaaaaaaaaaaaaaaaaaa", "completed"); // coalesces
    await mirror.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tarkovtracker.org/api/v2/progress/tasks");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual([
      { id: "aaaaaaaaaaaaaaaaaaaaaaaa", state: "completed" },
      { id: "bbbbbbbbbbbbbbbbbbbbbbbb", state: "failed" },
    ]);
    expect(mirror.status.queued).toBe(0);
    mirror.stop();
  });

  it("mirrors local quest.changed events when attached (started is not pushed)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const store = mem();
    const mirror = new TarkovTrackerMirror(store, { token: "PVP_test", fetchImpl, debounceMs: 60_000 });
    mirror.attach();

    store.applyQuestEvent({ taskId: "cccccccccccccccccccccccc", status: "completed", ts: "2026-07-11T01:00:00" });
    store.applyQuestEvent({ taskId: "dddddddddddddddddddddddd", status: "started", ts: "2026-07-11T01:00:01" });
    expect(mirror.status.queued).toBe(1);

    await mirror.flush();
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual([
      { id: "cccccccccccccccccccccccc", state: "completed" },
    ]);
    mirror.stop();
  });

  it("401 disables the mirror but keeps the queue and local data intact", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    const store = mem();
    store.applyQuestEvent({ taskId: "cccccccccccccccccccccccc", status: "completed", ts: "2026-07-11T01:00:00" });
    const mirror = new TarkovTrackerMirror(store, { token: "PVP_dead", fetchImpl, debounceMs: 60_000 });

    mirror.queueTask("cccccccccccccccccccccccc", "completed");
    await mirror.flush();
    expect(mirror.status.enabled).toBe(false);
    expect(mirror.status.disabledReason).toContain("401");
    expect(mirror.status.queued).toBe(1); // never lost
    expect(store.getTask("cccccccccccccccccccccccc")).toMatchObject({ complete: true }); // local untouched

    await mirror.flush(); // disabled → no further calls
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    mirror.stop();
  });

  it("network failure backs off exponentially without losing the queue, then recovers", async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("ETIMEDOUT");
      return jsonResponse({});
    });
    const mirror = new TarkovTrackerMirror(mem(), { token: "PVP_test", fetchImpl, debounceMs: 60_000 });
    mirror.queueTask("aaaaaaaaaaaaaaaaaaaaaaaa", "completed");

    await mirror.flush(1000);
    expect(mirror.status.queued).toBe(1);
    expect(mirror.status.backoffUntil).toBe(1000 + 5000);

    await mirror.flush(2000); // still inside backoff → no call
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fail = false;
    await mirror.flush(7000); // backoff elapsed → retries and clears
    expect(mirror.status.queued).toBe(0);
    expect(mirror.status.backoffUntil).toBeNull();
    mirror.stop();
  });

  it("epoch guard: pushes queued before a prestige reset are dropped and reconciled via re-read", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return String(url).endsWith("/progress") ? jsonResponse(progressFixture()) : jsonResponse({});
    });
    const store = mem();
    const mirror = new TarkovTrackerMirror(store, { token: "PVP_test", fetchImpl, debounceMs: 60_000 });

    mirror.queueTask("aaaaaaaaaaaaaaaaaaaaaaaa", "completed"); // queued under epoch 0
    store.bumpProgressEpoch(); // prestige reset
    await mirror.flush();

    // stale write dropped; reconciliation re-read happened; no task POST went out
    expect(calls).toEqual(["https://api.tarkovtracker.org/api/v2/progress"]);
    expect(mirror.status.queued).toBe(0);
    expect(store.level).toBe(42); // reconciled from remote
    mirror.stop();
  });
});
