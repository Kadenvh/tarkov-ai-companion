import { describe, it, expect } from "vitest";
import { mapDisplayName, tarkovDevMapId } from "../src/maps.js";

describe("maps", () => {
  it("resolves known raw location keys to display names", () => {
    expect(mapDisplayName("bigmap")).toBe("Customs");
    expect(mapDisplayName("factory4_night")).toBe("Factory (Night)");
    expect(mapDisplayName("tarkovstreets")).toBe("Streets of Tarkov");
  });

  it("title-cases unknown keys and handles null", () => {
    expect(mapDisplayName("new_map")).toBe("New Map");
    expect(mapDisplayName(null)).toBe("Unknown");
  });

  it("maps raw keys to tarkov.dev ids, collapsing variants", () => {
    expect(tarkovDevMapId("bigmap")).toBe("customs");
    expect(tarkovDevMapId("factory4_day")).toBe("factory");
    expect(tarkovDevMapId("factory4_night")).toBe("factory");
    expect(tarkovDevMapId("sandbox_high")).toBe("ground-zero");
    expect(tarkovDevMapId("laboratory")).toBe("the-lab");
  });

  it("returns null for maps tarkov.dev has no id for", () => {
    expect(tarkovDevMapId("terminal")).toBeNull();
    expect(tarkovDevMapId("nonsense")).toBeNull();
  });
});
