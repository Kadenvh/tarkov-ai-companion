import { describe, expect, it } from "vitest";
import { QuotaExhaustedError, QuotaLedger } from "../src/quota.js";
import { mutableMsClock } from "./helpers.js";

describe("QuotaLedger", () => {
  it("allows spending while the budget is unknown (first request)", () => {
    const ledger = new QuotaLedger();
    expect(ledger.canSpend("read")).toBe(true);
    expect(ledger.canSpend("write")).toBe(true);
    expect(ledger.state()).toEqual({});
  });

  it("parses X-RateLimit-* headers and exposes readsRemaining + resetsAt", () => {
    const clock = mutableMsClock(1_000_000);
    const ledger = new QuotaLedger(clock.now);

    ledger.updateFromHeaders(
      new Headers({
        "X-RateLimit-Limit": "1000",
        "X-RateLimit-Remaining": "37",
        "X-RateLimit-Reset": "1700000000", // epoch seconds
      }),
    );

    const state = ledger.state();
    expect(state.readsRemaining).toBe(37);
    expect(state.resetsAt).toBe(new Date(1700000000 * 1000).toISOString());
    expect(ledger.canSpend("read")).toBe(true);
  });

  it("blocks a read once the server reports 0 remaining", () => {
    const ledger = new QuotaLedger();
    ledger.updateFromHeaders(new Headers({ "X-RateLimit-Remaining": "0" }));
    expect(ledger.canSpend("read")).toBe(false);
    expect(ledger.state().readsRemaining).toBe(0);
  });

  it("captures Retry-After as a backoff hint and a reset horizon", () => {
    const clock = mutableMsClock(0);
    const ledger = new QuotaLedger(clock.now);
    ledger.updateFromHeaders(new Headers({ "Retry-After": "5" }));
    expect(ledger.retryDelayMs()).toBe(5000);
    expect(ledger.state().resetsAt).toBe(new Date(5000).toISOString());
  });

  it("treats a small X-RateLimit-Reset as seconds-from-now", () => {
    const clock = mutableMsClock(10_000);
    const ledger = new QuotaLedger(clock.now);
    ledger.updateFromHeaders(new Headers({ "X-RateLimit-Reset": "30" }));
    expect(ledger.state().resetsAt).toBe(new Date(10_000 + 30_000).toISOString());
  });

  it("QuotaExhaustedError carries the source id and kind", () => {
    const err = new QuotaExhaustedError("tarkovtracker", "read");
    expect(err.name).toBe("QuotaExhaustedError");
    expect(err.sourceId).toBe("tarkovtracker");
    expect(err.kind).toBe("read");
    expect(err.message).toMatch(/out of read quota/);
  });
});
