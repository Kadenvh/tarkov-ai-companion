import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQuestInfobox } from "../src/wiki/infobox.js";

const debut = readFileSync(join(import.meta.dirname, "fixtures", "debut.wikitext"), "utf8");

describe("parseQuestInfobox (Debut fixture, fetched live 2026-07-11)", () => {
  it("parses trader, prereqs, leads-to, and kappa flag", () => {
    const box = parseQuestInfobox(debut);
    expect(box).not.toBeNull();
    expect(box!.givenBy).toBe("Prapor");
    expect(box!.previous).toEqual(["Shooting Cans"]);
    expect(box!.leadsTo).toEqual(["Search Mission", "Luxurious Life"]);
    expect(box!.kappaRequired).toBe(true);
    expect(box!.location).toBeNull();
  });

  it("returns null when no infobox present", () => {
    expect(parseQuestInfobox("just some '''article''' text")).toBeNull();
  });
});
