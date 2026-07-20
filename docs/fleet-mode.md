# Fleet mode: verified shared memory + conflict firewall for agent swarms

Tracking epic: [#24](https://github.com/saiyam1814/memwarden/issues/24). All work
is labelled `fleet-mode`. This document is the durable design so a contributor (or
a fresh model with no chat context) can pick up the work from the repo alone.

## The problem

The AI-coding world is racing to run MANY agents at once: Claude Code Agent Teams,
worktree orchestrators (Agent Orchestrator, Shikigami, Conductor), the /batch
pattern (one change fanned out to many worktree agents, each opening a PR). They all
give agents parallel HANDS (isolated worktrees, terminals, PRs) and none give them a
shared, trustworthy BRAIN. In parallel, the agent-memory field's three named-unsolved
problems are staleness/invalidation, memory poisoning (OWASP ASI06), and shared
memory that "collapses at scale" (last-write-wins silently drops decisions; a
poisoned memory can go viral across a swarm).

memwarden already solves staleness and poisoning for a single agent. Fleet mode
extends that to the swarm.

## What fleet mode is

Not a rename, not a separate product. memwarden already runs as one daemon that every
agent points at, so the shared brain exists mechanically today. Fleet mode makes it
visible and adds the coordination + trust surface, via a `memwarden fleet` command
group and opt-in orchestrator adapters.

Four capabilities:

1. **Shared verified brain across the swarm** - what agent A learns, agent B knows;
   project-scoped. (Foundation exists.)
2. **Conflict firewall** - when two agents record contradictory decisions, surface it
   instead of last-write-wins silently dropping one.
3. **Poisoning containment** - one agent's unsourced/injected memory can never be
   served to another as `verified`; an agent or worktree can be marked untrusted.
4. **Pre-merge memory audit** - before N parallel PRs land, report which were built on
   `verified` vs `stale`/`unsourced` memory.

## Architecture: map to existing code

Fleet mode is mostly wiring existing primitives together across concurrent agents.

| Need | Already in the code |
| --- | --- |
| Shared substrate | one daemon (:3111), one brain (`~/.memwarden`); every tool wired via the host-adapter pattern in `src/cli/bin.ts` (`TOOLS`, `writeTool`, `writeMcpConfig`) |
| Trust classification | `classifyProvenance` in `src/functions/verify.ts` (verified / sourced / stale / unsourced) |
| Conflict detection | `detectConflicts` in `src/functions/conflicts.ts` (shipped in #2), currently on-demand inside `doctor` (`src/functions/doctor.ts`) |
| Consolidation + decay | `mem::consolidate-pipeline` in `src/functions/consolidate.ts` (shipped in #20) |
| Provenance + tamper-evidence | SHA-256 file hashing in the capture path; hash-chained oplog |
| Per-agent trust boundary | reuse the `adopted` flag path (`HookPayload.adopted` in `src/functions/types.ts` + guard in `src/functions/observe.ts`) which records hashless memory that can never reach `verified` |
| Agent identity + liveness | `agentId` / `projectKey` on `Session` and observations; `KV.hostHeartbeats` in `src/state/schema.ts` |
| Persistence | `StateKV` (`src/state/kv.ts`): `get/set/list/delete`; KV scopes in `src/state/schema.ts` |
| Orchestrator plug | MCP server `src/mcp/server.ts` (existing `memory_search`, `memory_remember`, ...) |
| REST surface | `src/triggers/api.ts` (existing `/memwarden/doctor`, `/memwarden/stats`, ...) |

New code centers on a `src/functions/fleet.ts` (registry + fleet-scoped conflict scan +
audit), a `fleet` command group in `src/cli/bin.ts`, `/memwarden/fleet/*` routes in
`src/triggers/api.ts`, and fleet MCP tools in `src/mcp/server.ts`.

## Roadmap

| Phase | Issue | Deliverable |
| --- | --- | --- |
| 1 (prereq) | #6 | proxy auto-capture for hook-less tools (guarantees capture across a heterogeneous swarm) |
| 1 (prereq) | #5 | global standing instruction / auto-recall in every project |
| 2 | #25 | agent registry: active agents per project |
| 2 | #26 | `memwarden fleet status` + REST |
| 3 | #27 | conflict firewall: `memwarden fleet conflicts` + `memory_conflicts` MCP tool (the headline) |
| 4 | #28 | per-agent / per-worktree trust boundary + verified-only swarm default |
| 5 | #29 | `memwarden fleet audit` + CI/GitHub Action gate |
| 6 | #30 | flagship orchestrator adapter + fleet MCP tools |
| 6b | design note below | memory-native fleet conductor (own the conductor, reuse an existing loop as the worker) |
| 7 | #4 | benchmark on the real REST/MCP path at swarm scale |

**MVP** = Phases 1-3 (#6, #5, #25, #26, #27). It already carries the flagship demo.

## Flagship demo (what phases 1-3 unlock)

Three agents, one repo, worktrees:
1. Agent A decides "refresh tokens rotate every 15m" and writes `auth.ts`. Captured,
   verified.
2. Agent B, in parallel and unaware, changes it to 60m in its worktree and records the
   new decision.
3. `memwarden fleet conflicts` lights up: Agent A says 15m, Agent B says 60m, same
   file, contradiction. A plain shared memory would have silently kept one and fed the
   swarm a lie.
4. Agent C asks "what is the rotation policy?" and gets the verified current answer
   plus the flagged conflict, not a coin-flip.
5. Before merge, `memwarden fleet audit` shows which agent's PR was built on
   now-stale memory.

## Design note: memory-native fleet conductor (Phase 6b)

Credit: raised by Rohit Ghumare (author of agentmemory). The observation: every
harness today is just an agent loop, and memory is always bolted on as an extension.
An extension is structurally limited because it lives outside the loop:

- it *guesses* when to capture (via hooks) instead of knowing, which is exactly why
  hook-less tools and the proxy (#6) are hard;
- it can *label* recall but cannot *gate* the loop (it can say "stale" but cannot stop
  the agent from acting on it);
- it cannot drive planning with verified context or route the loop around a conflict.

So the ceiling of the extension play (Phases 1-6) is real. Phase 6b is the answer,
scoped so it does not turn into "build a better Cursor":

- **Do not** build a general single-agent harness. That is a crowded, mature fight on
  the loop, which is not memwarden's edge, and it would dilute the memory work.
- **Do** build a thin **fleet conductor** (a meta-harness) where verified shared memory
  is the control plane, not a plugin. The conductor spawns and coordinates workers,
  and every step reads/writes/gates on verified memory natively. Reuse an existing
  agent loop (e.g. pi, or Claude Code) as the **worker**, so we own the
  conductor + memory integration and never rebuild the loop.

Why the conductor and not the single agent: the single-agent loop is crowded and
mature; the conductor over a fleet is young and is fundamentally a memory +
coordination problem, which is our home turf. This is the same territory as Phase 6,
promoted from "adapt into other people's orchestrators" to "also own a thin conductor
with memory as its spine."

**Sequencing (do not derail the MVP):** ship the extension play first (Phases 1-3)
because it is cheap, rides existing adoption, and proves the memory thesis with the
conflict-firewall demo. Graduate to the memory-native conductor only once the "an
extension cannot gate the loop" pain is demonstrably real. The extension is how
memwarden gets adopted; the memory-native conductor is how it becomes indispensable.
This is the top rung of the plan, not a separate direction. It will get its own
tracked spike issue when the extension play has validated demand.

## How to contribute

Each sub-issue is self-contained (context, exact files/functions, acceptance criteria,
tests). Filter issues by the `fleet-mode` label to see the whole plan. Phase 1 (#5,
#6) is the best on-ramp and unblocks the rest. Every change must keep `npx tsc
--noEmit` clean, `npm test` green, and `npm run eval` at 100% (the firewall gates).
Comment on an issue to claim it.
