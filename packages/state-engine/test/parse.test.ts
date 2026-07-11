import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LogEntryParser,
  parseEntry,
  parseLogFileText,
  parseLogText,
  normalizeMode,
  type ParsedEvent,
} from "../src/logs/parse.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "Logs");
const JUL = join(FIXTURES, "log_2026.07.11_4-38-37_1.0.6.0.46010");
const JAN = join(FIXTURES, "log_2026.01.30_7-20-20_1.0.1.1.42751");
const MAY = join(FIXTURES, "log_2026.05.25_12-34-11_1.0.5.0.45272");

/** fixture files keep the real naming: `<stamp>_<version> <stream>_000.log` */
function fixtureText(dir: string, stream: "application" | "push-notifications"): string {
  const folder = dir.slice(dir.lastIndexOf("log_") + 4);
  return readFileSync(join(dir, `${folder} ${stream}_000.log`), "utf8");
}

describe("log entry framing", () => {
  it("frames header lines and attaches multi-line JSON payloads", () => {
    const text = fixtureText(JUL, "push-notifications");
    const entries = parseLogText(text);
    expect(entries.length).toBeGreaterThan(10);
    const withJson = entries.filter((e) => e.json !== undefined);
    expect(withJson.length).toBeGreaterThanOrEqual(9); // 9 "Got notification |" events in this session
    const confirmed = withJson.find((e) => e.message.includes("UserConfirmed"));
    expect(confirmed?.ts).toMatch(/^2026-07-11T\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect((confirmed?.json as { location: string }).location).toBe("factory4_day");
  });

  it("is chunk-boundary tolerant (split mid-line and mid-JSON)", () => {
    const text = fixtureText(JUL, "push-notifications");
    const whole = parseLogText(text);
    const parser = new LogEntryParser();
    const chunked = [];
    for (let i = 0; i < text.length; i += 700) chunked.push(...parser.push(text.slice(i, i + 700)));
    chunked.push(...parser.flush());
    expect(chunked).toEqual(whole);
  });
});

describe("push-notifications semantic parsing (real 1.0.6 session)", () => {
  const events = parseLogFileText(fixtureText(JUL, "push-notifications"));

  it("extracts quest transitions from ChatMessageReceived types 10/12", () => {
    const quests = events.filter((e) => e.kind === "quest");
    expect(quests).toEqual([
      { kind: "quest", taskId: "68400926706e0a55e90b0007", status: "completed", ts: "2026-07-11T05:04:09.929" },
      { kind: "quest", taskId: "68400953506db3b4db0700e7", status: "started", ts: "2026-07-11T05:04:13.069" },
    ]);
  });

  it("extracts the raid lifecycle notifications with sid + location", () => {
    expect(events.filter((e) => e.kind === "matchCreated")).toHaveLength(3);
    const confirmed = events.filter((e) => e.kind === "matchConfirmed");
    expect(confirmed).toHaveLength(3);
    expect(confirmed[0]).toMatchObject({ location: "factory4_day", shortId: "0JJW2J" });
    expect((confirmed[0] as { sid: string }).sid).toContain("US-STL01G030");
    const over = events.filter((e) => e.kind === "matchOver");
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ location: "factory4_day", shortId: "0JJW2J", ts: "2026-07-11T05:22:07.133" });
  });
});

describe("push-notifications flea + failed-quest parsing (real 1.0.1 session)", () => {
  const events = parseLogFileText(fixtureText(JAN, "push-notifications"));

  it("detects flea sales (type 4, sold template) with rouble amounts", () => {
    const sales = events.filter((e) => e.kind === "fleaSale");
    expect(sales).toHaveLength(7);
    expect(sales[0]).toMatchObject({ itemId: "6389c8c5dbfd5e4b95197e6b", count: 1, amount: 397777 });
  });

  it("sees all three quest transition types", () => {
    const byStatus = new Map<string, number>();
    for (const e of events) if (e.kind === "quest") byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
    expect(byStatus.get("started")).toBe(2);
    expect(byStatus.get("failed")).toBe(1);
    expect(byStatus.get("completed")).toBe(4);
  });
});

describe("application log semantic parsing (real sessions)", () => {
  const events = parseLogFileText(fixtureText(MAY, "application"));

  it("detects session mode, profile, map loading, raid start and menu return", () => {
    expect(events.find((e) => e.kind === "sessionMode")).toMatchObject({ mode: "regular" });
    expect(events.find((e) => e.kind === "profile")).toMatchObject({
      profileId: "0123456789abcdef01234567",
      accountId: "1234567",
    });
    expect(events.find((e) => e.kind === "mapLoading")).toMatchObject({ rawLocation: "sandbox_high" });
    const found = events.find((e) => e.kind === "matchFound") as Extract<ParsedEvent, { kind: "matchFound" }>;
    expect(found.location).toBe("Sandbox_high"); // raw casing preserved; RaidAssembler normalizes
    expect(found.shortId).toBe("5X4540");
    expect(events.some((e) => e.kind === "gameStarting")).toBe(true);
    expect(events.some((e) => e.kind === "gameStarted")).toBe(true);
    expect(events.filter((e) => e.kind === "menu").length).toBeGreaterThanOrEqual(2);
  });

  it("parses the matching-cancelled variant and PVE session mode (synthetic lines)", () => {
    const cancelled = parseEntry({
      ts: "2026-02-02T19:33:54.949",
      version: "1.0.1.1.42751",
      level: "Info",
      channel: "application",
      message: "Network game matching cancelled.",
    });
    expect(cancelled).toMatchObject({ kind: "matchingCancelled" });
    expect(normalizeMode("Pve")).toBe("pve");
    expect(normalizeMode("Regular")).toBe("regular");
  });
});
