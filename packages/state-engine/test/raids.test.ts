import { describe, expect, it } from "vitest";
import { RaidAssembler } from "../src/logs/raids.js";
import type { ParsedEvent } from "../src/logs/parse.js";

const seq = (assembler: RaidAssembler, events: ParsedEvent[]) => events.flatMap((e) => assembler.next(e));

describe("RaidAssembler lifecycle", () => {
  it("assembles created → confirmed → started → matchOver with queue + duration", () => {
    const a = new RaidAssembler("regular");
    const signals = seq(a, [
      { kind: "sessionMode", mode: "regular", ts: "2026-07-11T05:00:00.000" },
      { kind: "matchCreated", ts: "2026-07-11T05:10:00.000" },
      { kind: "matchConfirmed", sid: "SID1", location: "Factory4_day", shortId: "AAAAAA", ts: "2026-07-11T05:10:08.000" },
      { kind: "matchFound", location: "factory4_day", sid: "SID1", shortId: "AAAAAA", profileId: null, ts: "2026-07-11T05:10:08.500" },
      { kind: "gameStarted", ts: "2026-07-11T05:10:52.000" },
      { kind: "matchOver", sid: "SID1", location: "factory4_day", shortId: "AAAAAA", ts: "2026-07-11T05:22:07.000" },
    ]);

    expect(signals.map((s) => s.type)).toEqual(["created", "confirmed", "started", "ended"]);
    const ended = signals.at(-1)!;
    expect(ended.draft).toMatchObject({
      sid: "SID1",
      map: "factory4_day", // normalized lowercase
      queuedAt: "2026-07-11T05:10:00.000",
      startedAt: "2026-07-11T05:10:52.000",
      endedAt: "2026-07-11T05:22:07.000",
      outcome: "unknown",
      endInferred: false,
    });
    expect(ended.draft.queueSec).toBeCloseTo(52, 0);
    expect(ended.draft.durationSec).toBeCloseTo(675, 0);
  });

  it("infers a raid end from the menu return when userMatchOver is missing", () => {
    const a = new RaidAssembler("regular");
    const signals = seq(a, [
      { kind: "matchCreated", ts: "T1" },
      { kind: "matchConfirmed", sid: "SID2", location: "Woods", shortId: "BBBBBB", ts: "2026-05-25T21:05:24.000" },
      { kind: "gameStarted", ts: "2026-05-25T21:06:23.000" },
      { kind: "menu", version: "1.0.5.0.45272", ts: "2026-05-25T21:41:53.000" },
    ]);
    const ended = signals.at(-1)!;
    expect(ended.type).toBe("ended");
    expect(ended.draft).toMatchObject({ map: "woods", endInferred: true });
    expect(ended.draft.durationSec).toBeCloseTo(2130, 0);
  });

  it("treats a repeated shortId as a reconnect, not a new raid", () => {
    const a = new RaidAssembler("regular");
    const first = seq(a, [
      { kind: "matchConfirmed", sid: "SID3", location: "bigmap", shortId: "CCCCCC", ts: "T1" },
      { kind: "gameStarted", ts: "T2" },
      { kind: "matchOver", sid: "SID3", location: "bigmap", shortId: "CCCCCC", ts: "T3" },
    ]);
    expect(first.filter((s) => s.type === "ended")).toHaveLength(1);

    // reconnect into the raid that just closed → nothing new
    const again = seq(a, [
      { kind: "matchConfirmed", sid: "SID3", location: "bigmap", shortId: "CCCCCC", ts: "T4" },
    ]);
    expect(again).toHaveLength(0);
  });

  it("drops an unstarted queue on matching cancelled and ignores menu noise", () => {
    const a = new RaidAssembler("regular");
    const signals = seq(a, [
      { kind: "menu", version: "1.0.6.0.46010", ts: "T0" }, // session-start menu — no raid pending
      { kind: "matchCreated", ts: "T1" },
      { kind: "matchingCancelled", ts: "T2" },
      { kind: "menu", version: "1.0.6.0.46010", ts: "T3" },
    ]);
    expect(signals.map((s) => s.type)).toEqual(["created"]);
  });

  it("flush closes out a raid left open at end of session", () => {
    const a = new RaidAssembler("pve");
    seq(a, [
      { kind: "matchConfirmed", sid: "SID4", location: "Lighthouse", shortId: "DDDDDD", ts: "T1" },
      { kind: "gameStarted", ts: "2026-07-11T06:00:00.000" },
    ]);
    const signals = a.flush("2026-07-11T06:30:00.000");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.draft).toMatchObject({ map: "lighthouse", mode: "pve", endInferred: true });
  });
});
