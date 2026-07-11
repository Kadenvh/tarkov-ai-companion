/**
 * Parser for the EFT wiki's `Infobox quest` template (M1.3).
 * Wiki content is CC-BY-SA — attribute when republishing.
 */

export interface QuestInfobox {
  givenBy: string | null;
  location: string | null;
  /** Wiki page titles of prerequisite quests */
  previous: string[];
  /** Wiki page titles of quests this leads to */
  leadsTo: string[];
  related: string[];
  kappaRequired: boolean | null;
}

/** Strip wiki markup from a value: [[A|B]] -> B, [[A]] -> A, <tags> removed. */
function clean(value: string): string {
  return value
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/'{2,}/g, "")
    .trim();
}

/** Extract [[Link targets]] (not display text) — these are wiki page titles, our join keys. */
function linkTargets(value: string): string[] {
  return [...value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
}

/**
 * Split template body into top-level `|key = value` params, respecting nested
 * [[..]] and {{..}} so values containing pipes don't split incorrectly.
 */
function templateParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "[[" || two === "{{") { depth++; current += two; i++; continue; }
    if (two === "]]" || two === "}}") { depth--; current += two; i++; continue; }
    if (body[i] === "|" && depth === 0) { parts.push(current); current = ""; continue; }
    current += body[i];
  }
  parts.push(current);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return params;
}

/** Locate the Infobox quest template and return its inner body. */
function infoboxBody(wikitext: string): string | null {
  const start = wikitext.search(/\{\{Infobox quest/i);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < wikitext.length - 1; i++) {
    const two = wikitext.slice(i, i + 2);
    if (two === "{{") { depth++; i++; continue; }
    if (two === "}}") {
      depth--;
      i++;
      if (depth === 0) return wikitext.slice(start + 2, i - 1);
    }
  }
  return null;
}

export function parseQuestInfobox(wikitext: string): QuestInfobox | null {
  const body = infoboxBody(wikitext);
  if (body === null) return null;
  const p = templateParams(body);

  const kappaRaw = p["reqkappa"] ? clean(p["reqkappa"]).toLowerCase() : "";
  return {
    givenBy: p["given by"] ? clean(p["given by"]) || null : null,
    location: p["location"] ? clean(p["location"]) || null : null,
    previous: p["previous"] ? linkTargets(p["previous"]) : [],
    leadsTo: p["leads to"] ? linkTargets(p["leads to"]) : [],
    related: [...linkTargets(p["related"] ?? ""), ...linkTargets(p["related2"] ?? "")],
    kappaRequired: kappaRaw === "" ? null : kappaRaw.startsWith("yes"),
  };
}
