import { describe, expect, it } from "vitest";
import { noticePayload, parseFrame, routeFrame, type FrameHandlers } from "../src/api/frames";

describe("parseFrame", () => {
  it("parses a JSON string frame", () => {
    expect(parseFrame('{"type":"raid.started","payload":{"map":"factory4_day"},"ts":"t"}')).toEqual({
      type: "raid.started",
      payload: { map: "factory4_day" },
      ts: "t",
    });
  });

  it("returns null for malformed JSON, non-objects, and missing type", () => {
    expect(parseFrame("{oops")).toBeNull();
    expect(parseFrame(42)).toBeNull();
    expect(parseFrame([1, 2])).toBeNull();
    expect(parseFrame({ payload: {} })).toBeNull();
    expect(parseFrame({ type: "" })).toBeNull();
  });
});

describe("routeFrame", () => {
  it("routes all four raid lifecycle events to onRaid with the right kind", () => {
    const kinds: string[] = [];
    const handlers: FrameHandlers = { onRaid: (kind) => kinds.push(kind) };
    for (const type of ["raid.created", "raid.confirmed", "raid.started", "raid.ended"]) {
      expect(routeFrame({ type, payload: {} }, handlers)).toBe(true);
    }
    expect(kinds).toEqual(["created", "confirmed", "started", "ended"]);
  });

  it("routes plan.updated, position, quest.changed and state.changed", () => {
    const hit: string[] = [];
    const handlers: FrameHandlers = {
      onPlanUpdated: () => hit.push("plan"),
      onPosition: (p) => hit.push(`pos:${p.x}`),
      onQuestChanged: (q) => hit.push(`quest:${q.status}`),
      onStateChanged: () => hit.push("state"),
    };
    routeFrame({ type: "plan.updated" }, handlers);
    routeFrame({ type: "position", payload: { x: 1, y: 2, z: 3, ts: "t" } }, handlers);
    routeFrame({ type: "quest.changed", payload: { taskId: "a", status: "completed", ts: "t" } }, handlers);
    routeFrame({ type: "state.changed", payload: { reason: "import", ts: "t" } }, handlers);
    expect(hit).toEqual(["plan", "pos:1", "quest:completed", "state"]);
  });

  it("returns false and calls onUnknown for unrecognized types", () => {
    let unknown = "";
    const handled = routeFrame({ type: "totally.new" }, { onUnknown: (f) => (unknown = f.type) });
    expect(handled).toBe(false);
    expect(unknown).toBe("totally.new");
  });

  it("routes hello with the profileKey payload", () => {
    let profile = "";
    routeFrame(
      { type: "hello", payload: { profileKey: "main-regular" } },
      { onHello: (p) => (profile = p.profileKey ?? "") },
    );
    expect(profile).toBe("main-regular");
  });
});

describe("noticePayload", () => {
  it("wraps bare-string notices", () => {
    expect(noticePayload("briefing ready")).toEqual({ message: "briefing ready" });
  });

  it("accepts message or text keys and keeps title/level", () => {
    expect(noticePayload({ text: "hi", title: "Agent", level: "warning" })).toEqual({
      message: "hi",
      title: "Agent",
      level: "warning",
    });
  });

  it("drops invalid levels and non-object garbage", () => {
    expect(noticePayload({ message: "x", level: "loud" })).toEqual({ message: "x" });
    expect(noticePayload(7)).toEqual({});
  });
});
