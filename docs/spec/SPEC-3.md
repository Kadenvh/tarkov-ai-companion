# SPEC-3 — AI Copilot (M4)

> Phase spec derived from [SPEC.md](../../SPEC.md) module **M4** (P3, plus M4.5 from P4). Status: **APP COMPLETE (2026-07-11)** — `apps/agent` built and tested; live-LLM verification deferred to the integration wave (auth finding below).

## Objective
Claude over ground truth: a copilot that answers, plans and briefs **only** from tool calls against the local service — zero unsourced game facts, explainable everywhere, and degradable to a clear 503 when no model backend is available (CONTRACTS §8).

## Scope (`apps/agent`, port 3142)
Tool-armed agent (M4.1), NL goal intake (M4.2), per-raid briefing (M4.3), event-driven replan (M4.4), learned weights proposer (M4.5). The agent talks to the world exclusively through the `@tac/service` HTTP/WS API (CONTRACTS §1) — it imports no game packages and holds no game state.

## Deliverables & status

| ID | Deliverable | Req | Status |
|---|---|---|---|
| 3.1 | `model.ts` — `ModelClient` abstraction with three backends: `AgentSdkClient` (`@anthropic-ai/claude-agent-sdk`, rides the machine's Claude Code login, tools exposed as an in-process SDK MCP server, built-in tools disabled), `ApiClient` (`@anthropic-ai/sdk` manual tool loop, `claude-opus-4-8` default, adaptive thinking on non-forced calls), `MockClient` (deterministic scenario table that executes the REAL tool executors). Selection: `TAC_AGENT_BACKEND=agent-sdk\|api\|mock`, `TAC_AGENT_MOCK=1` override; `agent-sdk` default | M4.1 | ✅ |
| 3.2 | `tools.ts` — CONTRACTS §8 tool belt: `get_state`, `get_plan`, `get_quartermaster`, `get_story`, `get_foresight`, `set_goals`, `lookup_task`, `wiki_cite`; zod input schemas + executors over the service REST API (`TAC_SERVICE_URL`, default `http://localhost:3141`); `wiki_cite` is pure URL construction (no network) | M4.1 | ✅ |
| 3.3 | `grounding.ts` — system prompt: never state a game fact not returned by a tool this conversation; cite the source tool; training knowledge declared stale; refuse 1.1.0/unreleased speculation; concise player-facing tone | M4.1 | ✅ |
| 3.4 | `goals-intake.ts` — NL text → `{goals, weights, notes}` via tool-forced JSON extraction (`emit_goals` capture tool, zod-validated, in-loop retry on validation failure + one whole-call retry) → persisted through the contracted `set_goals` tool | M4.2 | ✅ canonical example round-trips |
| 3.5 | `briefing.ts` — `generateBriefing(client, service, raidIndex)`: pulls plan + quartermaster + foresight + story via tools; structured (map, batch order w/ whys, bring-list, warnings, level before/after); <200-word cap enforced programmatically (one strict regeneration, then sentence-boundary truncation) | M4.3 | ✅ |
| 3.6 | `replan.ts` — `ReplanPipeline`: global-WebSocket client to service `/ws`, exponential-backoff auto-reconnect, `raid.ended` → 3 s debounce → fresh `GET /api/plan` → next-raid briefing → `POST /api/notify {title, body}`; idempotence guard keyed on raid `sid` (LRU-capped), dropped on failure so retries stay possible | M4.4 | ✅ |
| 3.7 | `weights.ts` — `proposeWeights({fingerprint, weights, mapOutcomes})`: pure + deterministic; per-map aversion for repeated deaths/abandons (≥50% bad rate, ≥3-raid sample) and mild preference for favoured+survived maps (share ≥25%, ≤20% bad); global task/xp nudges from `task_focus_ratio` (≥5 raids, not low-confidence); `mapCost` clamped to **[0.5, 3]**; every change carries a human-readable rationale; **never auto-applied** | M4.5 | ✅ |
| 3.8 | `server.ts` + `main.ts` — Fastify on 3142: `POST /chat` (per-session in-memory history, 32-session LRU, 40-message cap), `POST /briefing`, `GET /health`, `GET /propose-weights`, `POST /goals-intake`; `BackendUnavailableError` → **503 `{error: message + fix}`**, `/health` always 200 | M4.1–M4.5 | ✅ |
| 3.9 | `scripts/backend-smoke.ts` (`pnpm --filter @tac/agent smoke`) — one-shot real-backend init check | — | ✅ |
| 3.10 | README (run, env, Windows auto-start, auth note) + this spec | — | ✅ |

## Acceptance (M4 rows)

- **M4.1** — tool results are the only data channel; system prompt forbids unsourced facts and requires per-fact tool citations; mock-driven tests assert real service JSON flows into replies and that tool failures surface as errors, never invented answers. **Met** (live-LLM eval set = integration wave).
- **M4.2** — *"Kappa + Savior before prestige, hate Lighthouse"* → `goals:[{type:"kappa"}]` + `weights.mapCost.lighthouse = 1.5 (>1)` + a Savior story-ending guard note, persisted via `POST /api/goals`. **Met.**
- **M4.3** — briefing <200 words (enforced), structured, numbers verified ⊆ tool-result numbers; generated in milliseconds on mock and **verified against a live temp service instance** (real planner + 1.0.6 snapshot; see Live smoke). <10 s live-LLM latency check = integration wave. **Met at app level.**
- **M4.4** — WS `raid.ended` → replan → briefing → `POST /api/notify` fires end-to-end over a real WebSocket in tests, with idempotence and failure-retry proven. Replay against real logs rides the service's watcher (integration wave). **Met at app level.**
- **M4.5** — aversion rises for repeated deaths+abandons, caps respected, rationales present, deterministic, pure; surfaced via `GET /propose-weights`; only applied when the user confirms (via goals write). **Met.**

## Test evidence
**58/58 tests green** (`pnpm --filter @tac/agent test`), typecheck green under strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. All tests run on `MockClient` + a stub Fastify service (`test/stub-service.ts`, ephemeral port, canned CONTRACTS §5 payloads mirroring the real package shapes) — no external network, no Claude auth, no real EFT/Documents paths. Suites: tools/belt + `zodToJsonSchema` (10), grounding (7), goals intake (5), briefing incl. word-cap + factual-number-consistency (8), replan end-to-end over real WS incl. idempotence/retry (5), weights proposer (11), server + degradation + session LRU (12).

## Live smoke (2026-07-11, this machine)
- Booted `apps/service` on **3191** with `TAC_NO_WATCH=1` + temp `TAC_DATA_DIR`, seeded level 15 via `POST /api/state/manual`; booted the agent on 3199 (mock backend). `POST /briefing {raidIndex:1}` returned a structured, grounded briefing built from the **real** planner/quartermaster/foresight over the committed 1.0.6 snapshot:
  > "Raid 1 (get_plan): 653e6760052c01c1c805532f. Batch order: Saving the Mole — Kappa-required; then Burning Rubber — … Bring (get_quartermaster): 5000x Dollars (trader, 705000 roubles), 3x Aseptic bandage (find-in-raid), … Warnings (get_foresight): completing Supply Plans fails Kind of Sabotage; … Level 16 into the raid, 17 after."
  `/chat` ("what level am I?" → "You are level 15 (get_state).") and `/propose-weights` (empty journal → `noChange:true`) also verified live.
- **Real-backend auth is unavailable on this machine today**: the agent-sdk initializes (`available: ok`), but the spawned CLI reports *"Not logged in · Please run /login"* — the user's Claude login lives inside the Claude **Desktop** app package (`~/.claude/.credentials.json` holds only `mcpOAuth`, no `claudeAiOauth`), which a child SDK process cannot read; pointing `pathToClaudeCodeExecutable` at the Desktop binary fails the same way. `ANTHROPIC_API_KEY` is also unset. **The one real-LLM /briefing therefore moves to the integration wave** — fix is either `claude /login` with the standalone CLI or an API key (`TAC_AGENT_BACKEND=api`). The smoke surfaced (and we fixed) a real bug: an SDK `result/success` message can carry `is_error:true` with "Not logged in" as its text — the client now maps that to `BackendUnavailableError` (503) instead of returning it as a chat reply.

## Design decisions
- **Mock executes real executors.** `MockClient` is a scenario table over the *actual* tool belt, so every test crosses the HTTP boundary into the (stub) service — grounding is tested as plumbing, not as prompt text alone.
- **Forced-tool JSON extraction** for goals intake (`emit_goals` capture tool) instead of free-text JSON parsing: validation failures are reported back into the loop for a model-side retry, and the belt stays available for context lookups.
- **Word cap is code, not vibes**: regenerate once with a stricter instruction, then hard-truncate at a sentence boundary and flag `truncated`.
- **`available()` is honest on Windows**: it detects the standalone-CLI credential file (`claudeAiOauth`) or env keys; a Desktop-only login correctly reports `backendAvailable:false` on `/health`.
- **Plan envelope tolerance**: the live service returns `GET /api/plan` as `{hash, builtAt, goals, weights, plan}`; agent-side plan consumers (`unwrapPlan`, `lookup_task` fallback) accept both the envelope and a flat `Plan`.
- **Forced `tool_choice` disables adaptive thinking** on the `api` backend for that call (API incompatibility); non-forced calls run `thinking:{type:"adaptive"}` on `claude-opus-4-8`.

## Deviations / documented API additions
- **`POST /goals-intake {text}`** on the agent (3142) — addition beyond CONTRACTS §8's `/chat` + `/briefing`; it is the NL box endpoint the web Goals view calls (directly or via a service proxy). No contracted route was changed or removed.
- **`GET /propose-weights`** returns `{proposed, changes, noChange, current}`; the proposal is **not** persisted to `meta.learnedWeights` by the agent — persistence happens when the user confirms (a `POST /api/goals` write, or a future service-side confirm endpoint). Rationale: the agent is stateless by contract; auto-persisting even a "proposed" blob would create a second writer to the profile DB.
- **Consumed service extensions** (provided by the live `apps/service`): `GET /api/insights/fingerprint` (M7.3 payload) and `POST /api/notify` (§8). `lookup_task` prefers `GET /api/graph/task?name=` and degrades gracefully (plan-scan + graph summary) when the service 404s it.
- `@anthropic-ai/sdk` kept alongside the agent SDK as the `api` backend (CONTRACTS §8 anticipates `ANTHROPIC_API_KEY` support).

## Notes for the integration wave
1. **Live-LLM check**: once auth exists (standalone `claude /login` or `ANTHROPIC_API_KEY`), run `pnpm --filter @tac/agent smoke`, then one real `POST /briefing` — everything else is already proven live.
2. Service proxy (§5.5) points at `TAC_AGENT_URL`/`TAC_AGENT_PORT`; agent `/health` shape is `{ok, backend, backendAvailable, serviceReachable}`.
3. The web Goals NL box should call `POST /api/agent/chat` for conversation and (proxied) `/goals-intake` for structured extraction; render `toolCalls[]` as the "why/how sourced" affordance.
4. Weights-apply UX: fetch `GET /propose-weights`, show `changes[].rationale`, and on confirm write `proposed` via `POST /api/goals` (optionally mirroring to `meta.learnedWeights`).
