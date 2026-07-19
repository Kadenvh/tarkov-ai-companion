import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAlertPrefs, setAlertPrefs, fireAlert, playChime, unlockAudio } from "../src/lib/alerts";

/** Minimal in-memory localStorage on a fake window (node test env has none). */
function mockWindow(): void {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    // no AudioContext / speechSynthesis -> audio paths must degrade to no-ops
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("alert prefs", () => {
  beforeEach(mockWindow);

  it("defaults to disabled + no voice", () => {
    expect(getAlertPrefs()).toEqual({ enabled: false, voice: false });
  });

  it("round-trips through storage", () => {
    setAlertPrefs({ enabled: true, voice: true });
    expect(getAlertPrefs()).toEqual({ enabled: true, voice: true });
    setAlertPrefs({ enabled: true, voice: false });
    expect(getAlertPrefs()).toEqual({ enabled: true, voice: false });
  });

  it("coerces non-boolean / malformed stored values to safe defaults", () => {
    window.localStorage.setItem("tac.alerts", JSON.stringify({ enabled: "yes", voice: 1 }));
    expect(getAlertPrefs()).toEqual({ enabled: false, voice: false });
    window.localStorage.setItem("tac.alerts", "not json{");
    expect(getAlertPrefs()).toEqual({ enabled: false, voice: false });
  });
});

describe("alert firing guards", () => {
  it("is a no-op (never throws) when there is no window at all", () => {
    expect(() => getAlertPrefs()).not.toThrow();
    expect(getAlertPrefs()).toEqual({ enabled: false, voice: false });
    expect(() => fireAlert("x")).not.toThrow();
    expect(() => playChime()).not.toThrow();
    expect(() => unlockAudio()).not.toThrow();
  });

  it("does not touch audio when alerts are disabled", () => {
    mockWindow();
    setAlertPrefs({ enabled: false, voice: true });
    // disabled -> fireAlert returns before any audio call; no AudioContext exists anyway
    expect(() => fireAlert("raid over")).not.toThrow();
    delete (globalThis as { window?: unknown }).window;
  });

  it("degrades to no-ops when enabled but audio APIs are absent", () => {
    mockWindow();
    setAlertPrefs({ enabled: true, voice: true });
    expect(() => fireAlert("scav ready", { spoken: "scav ready" })).not.toThrow();
    delete (globalThis as { window?: unknown }).window;
  });
});
