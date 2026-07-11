# 07 — Story dataset verification against the EFT wiki

**Date:** 2026-07-11 · **Game version:** 1.0.6.0.46010 · **Dataset:** [`data/story/story.json`](../../data/story/story.json) · **Schema:** [`packages/data-core/src/story/schema.ts`](../../packages/data-core/src/story/schema.ts)

Every chapter, decision point and ending in the story dataset was re-checked against the Escape from Tarkov Fandom wiki via the MediaWiki API (`action=parse&prop=wikitext`), fetched 2026-07-11 with ≥1s spacing between requests. All 4 decision points now legitimately carry `confidence: "verified"`.

## Method

- Fetched raw wikitext for: `Endings`, `The_Ticket`, `Falling_Skies`, `Boreas`, `Story_chapters`, `Tour`, `Batya`, `Accidental_Witness`, `They_Are_Already_Here`, `Blue_Fire`, `The_Unheard`, `The_Labyrinth_(story_chapter)`.
- Compared each chapter's `stages[]` against the wiki `==Objectives==` section, each decision's `effects` against the wiki's per-ending branch headers (which carry explicit ending icons), and each ending's description/rewards against the `Endings` page.
- Note: WebFetch to fandom.com returns HTTP 402 (bot-blocked); plain `curl` against `https://escapefromtarkov.fandom.com/api.php` with a descriptive User-Agent works fine. Future re-verification should use the API route.

## Ending-mapping verification table

| # | Claim in dataset | Wiki source | Verdict |
|---|---|---|---|
| 1 | Exactly 4 endings: Savior, Survivor, Fallen, Debtor | [Endings](https://escapefromtarkov.fandom.com/wiki/Endings) — four `==` sections, one per ending | **Confirmed** |
| 2 | `ticket_kerman: no` → only Survivor reachable (`setsOnlyEnding: "survivor"`) | [The Ticket](https://escapefromtarkov.fandom.com/wiki/The_Ticket) §"If you refuse Mr. Kerman's offer" carries only the Survivor icon | **Confirmed** |
| 3 | `ticket_kerman: yes` → locks Survivor; Savior/Debtor/Fallen remain | The Ticket §"If you accept Mr. Kerman's offer" carries Savior + Debtor + Fallen icons only | **Confirmed** |
| 4 | `ticket_evidence: no` → only Fallen (`setsOnlyEnding: "fallen"`) | The Ticket §"…and refuse to find evidence on TerraGroup" carries only the Fallen icon | **Confirmed** |
| 5 | `ticket_evidence: yes` → locks Fallen; Savior/Debtor remain | The Ticket §"…and agree to find evidence on TerraGroup" carries Savior + Debtor icons | **Confirmed** |
| 6 | `ticket_final: hand_over_all` → Savior | The Ticket evidence branch: deliver 8 major (+36 minor optional) evidence → Fence 4.0 chain → Savior icon | **Confirmed** |
| 7 | `ticket_final: withhold_evidence` (max 2 major) → Debtor | The Ticket §"…but refuse to hand in **more than 2 major evidence**" carries only the Debtor icon | **Confirmed** (dataset label "hand in max 2 major" matches) |
| 8 | `falling_skies_case` locks **no** ending (both options keep all 4 reachable) | The Ticket: case-kept/case-given only alter costs and intermediate objectives in every branch; Endings page lists no case precondition | **Confirmed** |
| 9 | Case given → 1.5M ₽ (1M if "pretend you didn't find it"), "Man of His Word" achievement | [Falling Skies](https://escapefromtarkov.fandom.com/wiki/Falling_Skies) §Decision rewards | **Confirmed** |
| 10 | Case kept → Prapor rep **-0.3**, "Just Business" achievement | Falling Skies §Decision: Keep the armored case | **Confirmed** |
| 11 | Case given → The Ticket adds LK case-recovery chain (Lighthouse camp, 3 Blue Folders, ULTRA yellow flare + 15 kills on Interchange) | The Ticket §"If the Armored case was given to Prapor" | **Confirmed** |
| 12 | Survivor buyout: 300M ₽ (case given) / 500M ₽ (case kept) | The Ticket refuse-branch: "Collect the required amount in RUB: 300,000,000 / 500,000,000" | **Confirmed** |
| 13 | Survivor timed tasks (SSD evidence folders, 50 kills Streets, 4 PMCs one raid); failure costs Kappa container | The Ticket refuse-branch + "Only if you fail…: Hand over Secure container Kappa" | **Confirmed** |
| 14 | Fallen: Case with dangerous cargo + **$1,000,000** to Prapor; extra Prapor tasks (50 electronics, Theta/Epsilon/Kappa container, 40 repair kits) only if case kept | The Ticket Fallen branch ("Hand over 1,000,000 Dollars") | **Confirmed** (dollars, not roubles — dataset already correct) |
| 15 | Debtor tasks: topographic intel from 5 maps (Lighthouse, Woods, Customs, Ground Zero, Factory) on military flash drive; 30 PMC kills Woods; 100 dogtags; 6 Sacred Amulets stashed on Lighthouse | The Ticket Debtor branch | **Confirmed** |
| 16 | Savior tasks: Fence 4.0 rep + assignments + keep >4.0; Friendship Bridge (Woods) + Scav Lands (Reserve) co-op extracts; PvE alternative = 5 PMC kills Interchange/Shoreline; BTR Driver 0.4; Solar Power L1 | The Ticket Savior branch incl. both PvE notes | **Confirmed** |
| 17 | Terminal access items: Kerman hash-codes keycard (Savior), unknown-name keycard (Debtor), Prapor's letter (Survivor), Prapor hash-codes keycard (Fallen); intercom window 21:00–06:00 | The Ticket §"Arrive at the entrance pathway" items table + guide text | **Confirmed** |
| 18 | Terminal finale: security check, Black Division fights, 3-minute Zubr Boat window after pier door opens | The Ticket §"Escape from Tarkov" | **Confirmed** |
| 19 | Ending rewards: Savior $200K + cases + weapons ("biggest haul"); Debtor €120K + cases + weapons; Fallen 10M ₽ + money case; Survivor cosmetics only | Endings page rewards sections (PvE amounts differ: $40K / €30K / 3M ₽) | **Confirmed** |
| 20 | Ending narrative framing (Savior "truth escapes with you"; Survivor "escape alone, TerraGroup reborn"; Fallen "TerraGroup returns as savior"; Debtor "marked unreliable, bound by debt to LK") | Endings page quote blocks | **Confirmed** |

## Chapter stage-list verification

| Chapter | Wiki page | Verdict |
|---|---|---|
| Tour (25 stages) | [Tour](https://escapefromtarkov.fandom.com/wiki/Tour) | Confirmed. Dataset merges "Find a way to contact the soldiers" + "Use the intercom" into `tour-17`; Reserve/Lighthouse/Lab access sub-objectives are flattened into `tour-19..25` in wiki order. |
| Falling Skies (15) | [Falling Skies](https://escapefromtarkov.fandom.com/wiki/Falling_Skies) | Confirmed, incl. optional $2K Therapist SUV hint, FIR part hand-ins (3 batteries / 5 PCBs / 2 toolsets), optional Note from Mr. Kerman, case decision as point of no return. |
| Batya (21) | [Batya](https://escapefromtarkov.fandom.com/wiki/Batya) | Confirmed: Ryabina → Carousel → Gnezdo outposts, Moreman ambush, Intel Center L3, LK access, skill checks (LMG 5 / AR 10 / Stress 10 / Strength 15), 15-kills + 4-PMC-kills-without-dying challenges, traitor traces (Reserve bunker / Lighthouse & Interchange BEAR camps), Prapor interrogation, LK documents on The Unheard. |
| Accidental Witness (15) | [Accidental Witness](https://escapefromtarkov.fandom.com/wiki/Accidental_Witness) | Confirmed: Kozlov dorm (room 110), Zmeisky 3 apartment, Anastasia, courier Pasha, Reshala's bunkhouse, Kozlov's evidence tape. |
| They Are Already Here (18) | [They Are Already Here](https://escapefromtarkov.fandom.com/wiki/They_Are_Already_Here) | Confirmed: torture house (Lighthouse), victim's apartment (Streets), Book of the Arrival, one Cultist priest kill, chalet/Woods house/Sordi tower marks, Arshavin keycard restore, ARRS Station 14-4 KORD download + disconnect (two Interchange extracts), flash drive to Mechanic. Note: this chapter yields the **major evidence** needed for the Savior/Debtor evidence chain (second chance offered in The Ticket if missed). |
| Blue Fire (9) | [Blue Fire](https://escapefromtarkov.fandom.com/wiki/Blue_Fire) | Confirmed. Fragment choice: hand over = 1.5M ₽, keep = "Better Served" achievement — **no ending impact** (hint enriched this pass). Lab hacking-device objective auto-completes if already planted in Boreas. |
| The Ticket (33) | [The Ticket](https://escapefromtarkov.fandom.com/wiki/The_Ticket) | Confirmed across all four branches; conditional stages match wiki branch headers 1:1. |
| The Unheard (15) | [The Unheard](https://escapefromtarkov.fandom.com/wiki/The_Unheard) | Confirmed: Rzhevsky's G-Wagon HDD, Blue Ice catalyst docs, burnt document (Factory), A.P. trail (resort room → Sliderkey drive → 5M ₽ Mechanic decrypt → green keycard → Cardinal hidden room → Warden documents). |
| The Labyrinth (10) | [The Labyrinth (story chapter)](https://escapefromtarkov.fandom.com/wiki/The_Labyrinth_(story_chapter)) | Confirmed: Jaeger keycard wait, optional in-facility investigation chain, scientist's tape → Jaeger (500K ₽ + AXMC), facility research report (Theseus achievement). |
| Boreas (18 + 3 branch stages) | [Boreas](https://escapefromtarkov.fandom.com/wiki/Boreas) | Confirmed: poster/Intel-C3 start, Woods cell tower, Paradigm directive, transport branches (case given = AMG-10 only; case kept = +3 FIR Military power filters; Falling Skies incomplete = 30 Reserve kills + yellow flare at Woods transit), BTR-driver alternatives (vary with The Price of Independence / Choose Your Friends Wisely), hovercraft optionals (400K ₽ / green flare / €2.5K), icebreaker chain, C-1 hard drives, decode hand-ins (3 Ultralink / 4 RAM / 2 crypto processors, all FIR), scientist evacuation errands. |

## Changes made this pass

1. `bf-05` hint enriched: names the "Better Served" achievement for keeping the Item 1156 fragment (wiki: Blue Fire decision rewards).
2. No other data changes — the interrupted previous pass had already produced wiki-accurate content; this pass independently re-fetched all 12 pages and confirmed every claim before trusting the `confidence: "verified"` flags.

## Consistency validation

- `JSON.parse` clean; `parseStoryDataset` (zod) accepts the file; `pnpm --filter @tac/data-core test` green.
- No decision option both locks and unlocks the same ending: `ticket_kerman.yes` locks `survivor` while `ticket_kerman.no` setsOnly `survivor` (disjoint options); same pattern for `ticket_evidence`/`fallen`. `ticket_final` uses only `setsOnlyEnding` (savior/debtor). `falling_skies_case` locks nothing.
- Top-level `sources` map is an extra key not in the schema; zod `z.object` strips unknown keys on parse, so it survives as documentation in the raw JSON without breaking `parseStoryDataset`.

## Remaining unknowns / open items

- **PvE reward amounts** for endings ($40K / €30K / 3M ₽) are not encoded in the dataset (descriptions quote regular-mode values). Fine for the main-account regular-mode profile; revisit if a PvE profile is added.
- `bor-06c` (Falling Skies incomplete fallback) is encoded as `optional: true` because the schema's `condition` can only reference a decision, not chapter completion. Acceptable approximation; a future `schemaVersion: 2` could add a chapter-completion condition type.
- Wiki objective text for the Survivor start says "Swipe the Activated Kruglov's RFID keycard at the intercom reader" while the guide says Survivor uses the intercom **call button**; the dataset follows the guide (`tt-29`). Wiki self-inconsistency, not a data error.
- Useful facts recorded here but not in the dataset: Prapor's letter for the port checkpoint is purchasable 2×/trader reset for 5M ₽; the Debtor RFID keycard is purchasable 1×/raid from Lightkeeper for 1 Blue Folders material (this one IS in the decision note); dying with Secure container Alpha-1 mails you a replacement.
- `Story_chapters` page is only a chapter index (icons/banners) — chapter ordering in the dataset (`order` 1–10) is our editorial progression order, not sourced from that page.

## Attribution

Chapter, decision and ending content in `data/story/story.json` is derived from the [Escape from Tarkov Fandom wiki](https://escapefromtarkov.fandom.com), licensed under [CC-BY-SA 3.0](https://www.fandom.com/licensing). Text was paraphrased/condensed for the dataset; per-page source URLs are recorded in the dataset's top-level `sources` map and in the tables above. Downstream redistribution of the dataset must retain this attribution.
