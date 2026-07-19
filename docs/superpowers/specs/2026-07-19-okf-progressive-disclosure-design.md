# OKF Progressive Disclosure — Design

**Date:** 2026-07-19
**Status:** Approved (design); pending implementation plan
**Author:** David Gillot (with Claude)

## 1. Problem & goal

Every prompt pays a large first-token tax. lotl's `lotl_recall_hook.sh` runs on
each `UserPromptSubmit` and injects up to `LOTL_RECALL_MAX_LINES` (25) of raw
`memory recall` output. Because a single memory can be multi-KB (real examples
are 2–13KB each), a handful of recalled memories blow the context before the
agent reads the user's message. Session start also loads static instruction and
overview blocks.

**Primary goal:** cut the first-token load — both per-prompt recall and
session-start context.

**Strategic goal:** adopt Google's Open Knowledge Format (OKF) as lotl's
first-class knowledge model, positioning lotl as a lightweight, format-based
alternative to a heavyweight memory framework. OKF is a *format* (markdown +
YAML frontmatter, cross-linked concepts, `index.md` progressive disclosure), not
a search engine — its relevant property here is **progressive disclosure**: load
a tiny index up front, fetch full concept bodies on demand.

The token win comes from two compounding levers:
1. **Structural** — stop injecting bodies; inject an index instead.
2. **Content** — memories are terse ("caveman") to begin with, so even the index
   line and any fetched body are small.

## 2. Scope & non-goals

**In scope (this session):** OKF projection layer over lotl's existing SQLite
stores (approach "A"). SQLite stays the storage engine; OKF is a first-class
concept model and progressive-disclosure interface layered on top.

**Deferred (non-goals now):**
- **On-disk OKF ("B")** — memories/docs as git-diffable markdown files with
  SQLite derived. Parked *behind the `ConceptSource` seam* (§6) so it is a later
  additive backend, not a rewrite. It buys zero token savings; the driver is
  token load, so it is out of scope until portability is an explicit goal.
- Full OKF-native store rewrite ("C") — rejected; maximum blast radius, zero
  token benefit.
- No breaking changes to existing MCP tools; they remain alongside the new
  `okf_*` tools.

**Least-rework rationale:** the frozen contract (§4) — concept-id scheme,
frontmatter mapping, index format — is fixed once. Everything downstream (tools,
hook, agent contract, tests) sits behind it. Going to on-disk later swaps the
backend under that frozen interface with no id migration and no content
re-migration (the §5 caveman pass rewrites *content*, which is
backend-independent).

## 3. Terminology

- **Concept** — one unit of knowledge (a doc, a memory, or a knowledge-graph
  entity), addressable by a path-style **concept id**.
- **Bundle** — the whole navigable set of concepts (all collections + memory
  scopes + entity sets).
- **Index** — an OKF `index.md`-shaped listing (`* [Title](id) — description`).
- **Progressive disclosure** — navigate the bundle in levels (root → group →
  concept) instead of loading it whole.

## 4. The frozen contract

### 4.1 Concept model

| Field | Meaning | Required |
|---|---|---|
| `id` | path-style id, `.md` dropped (OKF concept-id) | ✓ |
| `type` | routing/filtering label | ✓ |
| `title` | display name | – |
| `description` | one caveman line — what the index shows | – |
| `tags` | cross-cutting labels | – |
| `timestamp` | ISO 8601 last-change | – |
| `links` | outbound concept ids (from `[[id]]` / md links in body) | – |
| `body` | short markdown | – |

Memory-specific fields (`scope`, `tier`, `importance`, `access_count`) ride as
**extension frontmatter keys** (OKF §4.1 allows arbitrary keys), so decay and
tiering keep working untouched.

### 4.2 Store → concept mapping

| lotl store | concept `id` | `type` | `description` | `links` |
|---|---|---|---|---|
| doc (documents table) | `docs/<collection>/<path>` | frontmatter type or `Document` | frontmatter `description` / first line | md links in body |
| memory (memories table) | `memory/<scope>/<id8>` | category → `Fact`/`Decision`/`Preference`/`Entity`/`Reflection` | the caveman one-liner | `[[id]]` refs |
| knowledge (triples) | `entities/<slug>` | `Entity` | latest valid fact | subject→object edges |

### 4.3 Concept-id scheme (must be right first time)

- Docs: `docs/<collection>/<path-without-.md>`.
- Memory: `memory/<scope>/<id8>` (scope + first 8 chars of the memory id).
- Entities: `entities/<slug>`.

Ids are referenced by the index, by `[[links]]`, and by every `get` call. They
are identical whether the backend is SQLite (now) or on-disk files (later), so
"B" is a backend swap, not an id migration.

## 5. Caveman memory rules

### 5.1 Target shape

| Part | Budget | Holds |
|---|---|---|
| `description` (index line) | ≤ 1 line (~120 chars) | the one caveman claim |
| `body` | ≤ ~6 short lines (~500 chars) | load-bearing specifics: ids, `file:line`, the decision, the one gotcha |
| overflow | not in the memory | long narrative → dropped or linked to a devnote concept as a citation |

"Still good but clean" = keep the signal (ids, decisions, file refs, gotchas,
`[[links]]`), cut narrative, redundancy, and session play-by-play. Facts, not
prose.

Example — a ~2.5KB memory compresses to ~400 chars keeping every load-bearing
fact (id, branch/commit, the one gotcha, the `[[link]]`).

### 5.2 Migration of existing memories (reversible)

1. LLM pass via `llm.chatComplete` rewrites each over-budget memory →
   `{description, body}` within budget, preserving `id`, `scope`, `category`,
   `timestamp`, `[[links]]`.
2. Original text archived in `metadata.original` — nothing lost, one-command
   revert.
3. Low-confidence rewrites go to a **review queue**, not auto-applied
   (escalate-on-doubt).
4. Command: `lotl memory compact [--dry-run] [--apply]`; dry-run shows
   before/after diffs first.

### 5.3 Write-time enforcement (going forward)

`memory_add` and the extractor cap length; over-budget input is auto-compressed
to caveman via the same `chatComplete` path (or rejected with guidance). Fat
memories are stopped at the source, so migration is a one-time cleanup.

## 6. Progressive-disclosure interface

### 6.1 Three levels

| Level | Tool | Returns | Size |
|---|---|---|---|
| 1. Root index | `okf_index()` | groups only (collections, memory scopes, entity sets) with count + one-line description | dozens of lines |
| 2. Drill | `okf_index(path)` | concept lines in that group, paginated | bounded |
| 3. Body | `okf_get(id)` | one full concept (routes by id prefix to the existing doc/memory/kg getter) | one concept |

All levels emit the OKF `index.md` shape (§6): `* [Title](id) — description`.

### 6.2 Recall-hook rewrite (the big per-prompt tax)

- Today: `lotl memory recall <prompt> | head -25` → up to 25 full memory blobs.
- New: `lotl okf recall <prompt>` → top-K matching **index lines** (id + type +
  description), never bodies, hard-capped (~8 lines). Agent calls `okf_get` only
  for what it needs.

Token math per prompt: now = 25 × (blob up to ~13KB) → 10KB+; new = ~8 ×
(~80-char line) → ≈0.5KB.

### 6.3 Session start

The always-injected block becomes `okf_index()` root (groups, tiny) plus a
one-line "call `okf_get(id)` to open a concept" instruction — no memory dump.

### 6.4 Read-path discipline

Index/recall read only light columns (`id, type, description`) — never bodies or
embeddings, same explicit-column rule as `memory/server.ts`. Bodies load only on
`okf_get`.

### 6.5 Error handling

Hook stays fail-open (empty/error → inject nothing, exit 0). Unknown id →
not-found. Broken links tolerated (OKF §9).

## 7. Component layout

New first-class module `src/okf/`:

| File | Role | Depends on |
|---|---|---|
| `src/okf/concept.ts` | Concept type; id scheme (parse/build, prefix-route); frontmatter mapping | types only |
| `src/okf/source.ts` | **`ConceptSource` interface** (`listGroups()`, `listConcepts(group)`, `getConcept(id)`) + `SqliteConceptSource` impl | store/memory/knowledge read fns |
| `src/okf/index-render.ts` | OKF `index.md` render, grouping, pagination | concept.ts |
| `src/okf/recall.ts` | query → top-K index lines | source.ts |
| `src/okf/budget.ts` | caveman budgets + `compact()` helper (via `chatComplete`) | llm.ts |

Wiring changes (additive; old tools kept):
- `src/mcp/server.ts` — add `okf_index`, `okf_get`, `okf_recall`.
- `src/cli/lotl.ts` — add `okf index|get|recall` + `memory compact`.
- `src/memory/index.ts` + `extractor.ts` — write-time budget enforcement.
- `src/memory/compact.ts` — migration pass (rewrite → archive → review queue).
- `hooks/lotl_recall_hook.sh` — call `lotl okf recall` (index lines).
- `src/openclaw/plugin.ts` `before_prompt_build` — emit `okf_index` root at
  session start.

### 7.1 The seam that makes "B" zero-rework

`ConceptSource` is the single boundary. Everything above it (tools, hook, index,
recall, budget, agent contract, tests) talks only to that interface. Today the
only impl is `SqliteConceptSource`. On-disk "B" adds a `FileConceptSource` and
nothing above the seam changes.

## 8. Testing

Temp-SQLite pattern (as in `test/memory-server.test.ts`); ≥80% coverage.

- Unit: id parse/build + prefix routing; frontmatter mapping; `index.md` render;
  budget enforcement (over-budget → compacted within caps); `okf recall` returns
  index-lines-not-bodies (byte-cap assertion).
- Integration: `SqliteConceptSource` three-level disclosure on a seeded db;
  `okf_get` routing; migration dry-run diff → apply → archive → revert →
  review-queue.
- Regression: old tools + existing tests stay green.

## 9. Safety rollout (all reversible)

- Feature flag `LOTL_OKF=on` gates the hook + session-start swap; old recall path
  retained until proven.
- Migration is dry-run-first, archives `metadata.original`, low-confidence →
  review queue.
- Old MCP tools kept → no breaking change.

## 10. Build model

- **Opus** writes the plan as **compartments** — each `src/okf/` piece + each
  wiring change as an isolated unit with a fixed interface, inputs/outputs, its
  tests, and done-criteria.
- **Sonnet subagents** build one compartment at a time, TDD, against the frozen
  `ConceptSource` contract so they can't drift. Verify (typecheck + tests) after
  each.
- **Escalate-on-doubt:** a Sonnet agent that hits any ambiguity or interface
  question stops and returns it to Opus to re-plan that compartment — no
  guessing.
- Order: contract (`concept.ts`, `source.ts`) + tests → index/recall/budget →
  wiring (mcp, cli, hook, plugin) → migration → docs/changelog.

## 11. Locked decisions

- Approach **A** (projection layer), OKF as first-class model, SQLite behind the
  `ConceptSource` seam.
- Concept-id scheme per §4.3; `scope`/`tier`/`importance` as extension
  frontmatter, not core model.
- Caveman budgets per §5.1; migration archives originals in `metadata.original`;
  low-confidence rewrites reviewed, not blind-applied.
- Three-level disclosure; `okf recall` returns index lines, not bodies; old tools
  kept.
- On-disk "B" deferred behind the seam.
