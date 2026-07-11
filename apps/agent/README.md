# @tac/agent — AI Copilot (M4)

Claude over ground truth. A small Fastify service (port **3142**) that answers questions, writes goal configs, and generates pre-raid briefings — with every game fact sourced from a tool call against the `@tac/service` REST API. The agent holds **no game state of its own** and never touches the game or its files (**@tier T0**).

## What it does

| Feature | Module | Surface |
|---|---|---|
| Tool-armed chat (M4.1) | `src/model.ts`, `src/tools.ts`, `src/grounding.ts` | `POST /chat {message, sessionId?}` → `{reply, toolCalls[]}` |
| NL goals intake (M4.2) | `src/goals-intake.ts` | `POST /goals-intake {text}` → `{goals, weights, notes, toolCalls}` |
| Per-raid briefing, <200 words (M4.3) | `src/briefing.ts` | `POST /briefing {raidIndex}` → `{briefing, toolCalls}` |
| Event-driven replan (M4.4) | `src/replan.ts` | subscribes to service `/ws`; on `raid.ended` → replan → briefing → `POST /api/notify` |
| Learned weights, never auto-applied (M4.5) | `src/weights.ts` | `GET /propose-weights` → `{proposed, changes[], noChange, current}` |
| Health | `src/server.ts` | `GET /health` → `{ok, backend, backendAvailable, serviceReachable}` (always 200) |

The tool belt (CONTRACTS §8): `get_state`, `get_plan`, `get_quartermaster`, `get_story`, `get_foresight`, `set_goals`, `lookup_task`, `wiki_cite` — each a zod-validated executor over the service API. The system prompt (`src/grounding.ts`) forbids stating any game fact not returned by a tool in the current conversation, requires citing the source tool, and refuses 1.1.0/unreleased speculation.

## Model backends

`src/model.ts` defines one `ModelClient` interface with three implementations, selected by `TAC_AGENT_BACKEND` (`agent-sdk` | `api` | `mock`; `TAC_AGENT_MOCK=1` forces mock):

- **`agent-sdk`** (default) — `@anthropic-ai/claude-agent-sdk`; spawns Claude Code and rides this machine's Claude Code login. Tools are exposed as an in-process SDK MCP server; all built-in tools (Bash, Read, …) are disabled.
- **`api`** — plain `@anthropic-ai/sdk` manual tool loop; needs `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`). Model defaults to `claude-opus-4-8`; override with `TAC_AGENT_MODEL`.
- **`mock`** — deterministic scenario table that still executes the REAL tool executors, so tests (and offline demos) exercise the full service plumbing without any Claude auth.

> **Auth note (verified live 2026-07-11):** a Claude *Desktop*-app login is not visible to a spawned agent-sdk process — the child CLI reports "Not logged in". For live use either log in once with the standalone Claude Code CLI (`claude` → `/login`, which writes `~/.claude/.credentials.json`) or set `ANTHROPIC_API_KEY` with `TAC_AGENT_BACKEND=api`. Check with `pnpm --filter @tac/agent smoke` (one cheap real call). When the backend is unavailable, `/chat` and `/briefing` return **503 with a how-to-fix message**; `/health` stays 200.

## Run

```powershell
# prerequisites: @tac/service running on 3141 (or set TAC_SERVICE_URL)
pnpm --filter @tac/agent start          # agent on http://127.0.0.1:3142
pnpm --filter @tac/agent dev            # watch mode
pnpm --filter @tac/agent smoke          # one-shot backend auth check
```

Environment:

| Var | Default | Meaning |
|---|---|---|
| `TAC_AGENT_PORT` | `3142` | HTTP port |
| `TAC_SERVICE_URL` | `http://localhost:3141` | service base URL (REST + `/ws`) |
| `TAC_AGENT_BACKEND` | `agent-sdk` | `agent-sdk` \| `api` \| `mock` |
| `TAC_AGENT_MOCK` | — | `1` forces the mock backend |
| `TAC_AGENT_MODEL` | `claude-opus-4-8` (api) / Claude Code default (agent-sdk) | model override |
| `TAC_AGENT_NO_REPLAN` | — | `1` disables the WS replan pipeline |
| `ANTHROPIC_API_KEY` | — | required for the `api` backend |

### Windows auto-start

Run the agent alongside the service at logon via Task Scheduler (no admin needed):

```powershell
$action = New-ScheduledTaskAction -Execute "pnpm" -Argument "--filter @tac/agent start" -WorkingDirectory "C:\Users\Kaden\tarkov-aim-lab"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "TAC Agent" -Action $action -Trigger $trigger
```

(Or add both `@tac/service` and `@tac/agent` `start` commands to a single `.cmd` in `shell:startup`.) The replan pipeline auto-reconnects with backoff, so start order relative to the service does not matter.

## Test

```powershell
pnpm --filter @tac/agent typecheck
pnpm --filter @tac/agent test          # 58 tests, all offline
```

Tests run entirely on the **mock** backend plus a stub Fastify service (`test/stub-service.ts`) with canned CONTRACTS §5 responses on an ephemeral port — no external network, no real EFT paths, no Claude auth. Coverage: grounding rules + tool plumbing, goals-intake round-trip (canonical "Kappa + Savior before prestige, hate Lighthouse"), briefing word cap/structure/factual consistency, replan pipeline end-to-end over a real WebSocket (including idempotence and failure retry), weights proposer (aversion, caps, rationale, determinism, purity), server degradation (503 + healthy `/health`), session LRU.

## Design notes

- **Grounding is structural, not just prompted**: tool results are the only data channel; the mock backend proves the plumbing carries real service JSON into replies.
- **Briefing cap enforced programmatically**: one strict regeneration, then hard truncation at a sentence boundary (`truncated: true` in the result).
- **Replan idempotence**: one replan per raid end (keyed on `sid`), guard dropped on failure so a later event can retry; 3 s debounce lets post-raid quest/state churn settle.
- **Learned weights are proposals only** (CONTRACTS §8): pure, deterministic, capped (`mapCost` ∈ [0.5, 3]), each change carries a human-readable rationale; applying them is the user's `POST /api/goals` action.
- **Plan envelope tolerance**: the live service wraps `GET /api/plan` as `{hash, …, plan}` — plan consumers unwrap either shape.
