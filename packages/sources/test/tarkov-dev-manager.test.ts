import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT } from "../src/http.js";
import {
  SubmitDisabledError,
  createTarkovDevManagerSource,
  type GoonsSubmission,
  type QueueSubmission,
} from "../src/sources/tarkov-dev-manager.js";
import { jsonResponse, scriptedFetch } from "./helpers.js";

const QUEUE: QueueSubmission = { map: "bigmap", time: 42, type: "PVP", gameMode: "regular" };
const GOONS: GoonsSubmission = { map: "woods", accountId: 123456, gameMode: "pve" };

describe("tarkov-dev-manager source (fixtures)", () => {
  it("advertises submit, kind rest, read-only reads (no quota), disabled by default", () => {
    const source = createTarkovDevManagerSource();
    expect(source.id).toBe("tarkov-dev-manager");
    expect(source.kind).toBe("rest");
    expect(source.capabilities).toEqual(["submit"]);
    expect(source.enabled).toBe(false);
    expect(source.quota).toBeUndefined();
    expect(source.baseUrl).toContain("manager.tarkov.dev");
  });

  it("submit throws SubmitDisabledError when disabled (the default) and NEVER touches the network", async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse({}, { status: 200 })]);
    const source = createTarkovDevManagerSource({ fetchImpl }); // enabled omitted → false
    await expect(source.submit("queue", QUEUE)).rejects.toBeInstanceOf(SubmitDisabledError);
    await expect(source.submit("goons", GOONS)).rejects.toThrow(/off by default/);
    expect(calls.length).toBe(0); // no POST was ever attempted
  });

  it("health reports missing while disabled (surfaced as up:false)", async () => {
    const source = createTarkovDevManagerSource();
    expect(await source.health()).toBe("missing");
  });

  it("fetch throws — this is a submit-only (write) endpoint, not a read source", async () => {
    const source = createTarkovDevManagerSource({ enabled: true });
    await expect(source.fetch({ capability: "submit", path: "/queue" })).rejects.toThrow(
      /submit-only/,
    );
  });

  it("when enabled, POSTs the verified /queue shape {map,time,type,gameMode} to the right path", async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse({ ok: true }, { status: 200 })]);
    const source = createTarkovDevManagerSource({ enabled: true, fetchImpl });

    const result = await source.submit("queue", QUEUE);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.path).toBe("/queue");

    const call = calls[0]!;
    expect(call.url).toBe("https://manager.tarkov.dev/api/queue");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers?.["User-Agent"]).toBe(DEFAULT_USER_AGENT);
    expect(call.init?.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call.init?.body ?? "{}")).toEqual({
      map: "bigmap",
      time: 42,
      type: "PVP",
      gameMode: "regular",
    });
  });

  it("when enabled, POSTs the verified /goons shape {map,gameMode,timestamp(UnixMS),accountId(int)}", async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse({ ok: true }, { status: 200 })]);
    const source = createTarkovDevManagerSource({
      enabled: true,
      fetchImpl,
      now: () => 1_700_000_000_000,
    });

    const result = await source.submit("goons", GOONS);
    expect(result.path).toBe("/goons");
    const call = calls[0]!;
    expect(call.url).toBe("https://manager.tarkov.dev/api/goons");
    expect(JSON.parse(call.init?.body ?? "{}")).toEqual({
      map: "woods",
      gameMode: "pve", // normalized like monitor's submit.ts
      timestamp: 1_700_000_000_000, // Unix milliseconds
      accountId: 123456, // integer
    });
  });

  it("goons defaults the timestamp to the source clock when omitted", async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse({}, { status: 200 })]);
    const source = createTarkovDevManagerSource({ enabled: true, fetchImpl, now: () => 999 });
    await source.submit("goons", { map: "shoreline", accountId: null, gameMode: "regular" });
    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.timestamp).toBe(999);
    expect(body.accountId).toBeNull();
  });

  it("records lastError and reports ok:false on a non-2xx submit response", async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse({}, { status: 400 })]);
    const source = createTarkovDevManagerSource({ enabled: true, fetchImpl });
    const result = await source.submit("queue", QUEUE);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(source.stats?.().lastError).toMatch(/-> 400/);
    expect(await source.health()).toBe("error");
  });

  it("respects a base URL override", async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse({}, { status: 200 })]);
    const source = createTarkovDevManagerSource({
      enabled: true,
      fetchImpl,
      baseUrl: "https://example.test/api/",
    });
    await source.submit("queue", QUEUE);
    expect(calls[0]?.url).toBe("https://example.test/api/queue");
  });
});
