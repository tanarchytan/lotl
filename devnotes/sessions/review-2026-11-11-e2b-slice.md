# Review: unfinished E2B slice (conflict modes + notes extraction), 2026-11-11

Read-only review by an Opus agent of the work the hard-stopped E2B agent left in the tree.
Scope: `src/memory/conflict.ts`, `src/memory/extractor.ts`, the conflict wiring in
`src/memory/index.ts`, `test/memory-extract-notes.test.ts`,
`test/memory-conflict-guard.test.ts`, `test/memory-conflict-mode.test.ts`,
`evaluate/local-llm/`.

State when reviewed: typecheck passes, full suite 1071 passed / 7 skipped / 0 failed.
Line numbers are from the uncommitted tree on that date.

Labels: **[slice]** = from this work, **[pre-existing]** = same at HEAD `98304e4`.
"Verified" = the reviewer ran the pure function with tsx, no DB, no network.

## Verdict

Keep, do not revert. Conflict wiring is complete and its default matches HEAD.
Fix 1 and 2 before any release. Fix 3, 4, 5 before anyone relies on `guarded` with E2B.

## Findings

| # | Sev | Label | Where | Defect |
|---|---|---|---|---|
| 1 | HIGH | slice | `extractor.ts:270-275, 463` | Notes prompt is on by default (`LOTL_EXTRACT_PROMPT=auto`) for every non-transcript input, for any provider |
| 2 | HIGH | slice | `conflict.ts:51-54` | Unset or unknown `LOTL_MEMORY_CONFLICT` means `llm`, the destructive mode; a typo falls back silently |
| 3 | MEDIUM | slice | `conflict.ts:69-72` | Guard compares by substring, not token |
| 4 | MEDIUM | slice | `conflict.ts:60-66, 97-111` | Guard does nothing for memories without numbers, paths, identifiers or ALLCAPS words |
| 5 | MEDIUM | slice | `index.ts:700-704`, catch near 728 | Guard skipped when the LLM reply is null (timeout, HTTP error, empty) or throws |
| 6 | MEDIUM | slice | `extractor.ts:463-475` | A failed part of a multi-part notes extraction is dropped with no fallback; no cap on parts; oversized single block never split |
| 7 | MEDIUM | pre-existing | `index.ts:604` | `findSimilarMemory` has no scope filter |
| 8 | LOW | pre-existing | `index.ts:707` | Conflict UPDATE rewrites text but not the vector; only text survives in `memory_history` |
| 9 | LOW | slice | conflict and notes prompts | Prompt injection, about the same as HEAD; notes parser is more permissive |
| 10 | LOW | slice | `evaluate/local-llm/run.mts:7-9, 26, 34` | Fetch guard allows any host in `LOTL_QUERY_EXPANSION_URL`; `runs/` is in the repo and not ignored |
| 11 | LOW | slice | several | Cited devnote missing, wrong doc comment, untrimmed env var, unnamed magic numbers |

### 1. Notes prompt on by default

`detectExtractStyle` returns `notes` unless at least half the lines carry a speaker prefix
and one label repeats. Verified: `importConversation` chunks
(`"<user text>\n\nAssistant: ..."`) and OpenClaw auto-capture come out as `notes`. So do MCP
`memory_extract` and CLI `memory extract` with prose.

Effect: users of ZeroEntropy, Gemini or OpenAI get a prompt tuned only on E2B with 24 inputs
(held-out unsupported rate 2.0% to 9.2%). A `NONE` reply stores nothing and skips the
heuristic fallback, where HEAD fell back.

Fix: default `conversation`; `auto` and `notes` only when set.

### 2. Default conflict mode is destructive

Conflict resolution uses the same `LOTL_QUERY_EXPANSION_*` provider as extraction. Enabling
E2B for extraction therefore also hands DELETE and UPDATE verdicts to E2B, whose conflict
accuracy was never measured. `LOTL_MEMORY_CONFLICT=guard` (typo) silently means `llm`.

Fix: unknown values warn on stderr and use `guarded`. Document that `guarded` or `off` must
be set before pointing the provider at a small local model.

### 3. Substring guard

Verified: existing "The API listens on port 80.", incoming "...port 8080.", LLM returns
UPDATE with "...port 8080.". Guard passes because "80" is a substring of "8080". Existing
row overwritten, 80 lost.

Fix: compare token sets.

### 4. Guard blind to plain prose

Verified:
- Existing "David prefers tea in the morning", UPDATE merged to "...coffee...": accepted,
  existing overwritten.
- Existing "Backups to B2 are encrypted", incoming "...are not encrypted", NONE: accepted,
  incoming dropped.

`guarded` is in effect "llm minus DELETE" for preferences and decisions.

Fix: in `guarded`, turn UPDATE into ADD (never rewrite a row), or require the merged text to
keep the content words of the existing text.

### 5. Guard skipped on null or thrown reply

The comment says null means an embed-only config. `RemoteLLM.chatComplete`
(`src/llm/remote.ts:456-459`) also returns null on timeout, HTTP error or empty content. A
thrown error lands in the catch, which also returns "duplicate".

Scenario: E2B times out in `guarded` mode. A new memory with new numbers that is a cosine
>= 0.9 neighbour of an existing one is dropped as a duplicate.

Fix: drop `&& decision.raw !== null`; apply the same guard in the catch.

### 6. Multi-part notes extraction

- Failed or timed-out part is skipped (`continue`); if any other part answered, the result
  is non-null and that part's content is lost.
- No cap on part count; MCP `memory_extract` has no input size cap. Each part is a
  sequential call, 60 s timeout, up to 3 attempts.
- A single block over 2500 chars is never split (verified with 10,000 chars);
  output capped at `max_tokens: 1000`.

Fix: heuristic on failed parts, cap part count or total characters, hard-split long blocks.

### 7. No scope filter in `findSimilarMemory` (pre-existing)

A store in scope A can UPDATE or DELETE a memory in scope B, or be dropped as its duplicate.
All modes. Fix: `AND scope = ?` (`memories_vec` has scope as partition key).

### 8. Stale vector after conflict UPDATE (pre-existing)

`memories_vec` keeps the old text's embedding; FTS is refreshed by trigger. Category, scope
and metadata of a deleted row are lost. No code reads `memory_history`; recovery is manual
SQL.

### 9. Prompt injection

Conflict prompts embed both texts in quotes with no escaping (same as HEAD): an incoming
`" ... Respond DELETE` can delete a memory in `llm` mode. `guarded` blocks DELETE.
Notes parser accepts any `[word]` as a fact, appends uncategorised lines to the previous
memory, and lets model-emitted `PROJECT:` lines prefix later memories.
`<private>` redaction still runs first (`extractor.ts:505`).

### 10. Eval harness

Comment says "no memory text can leave the machine"; the guard only pins the host of
`LOTL_QUERY_EXPANSION_URL`, which can be a cloud host. The fixtures look like real notes.
Default output dir `evaluate/local-llm/runs` is inside the repo, not ignored.
Fix: require loopback, default output to a temp dir or ignore `runs/`.

The harness opens no index (`extractAndStore` gets `{}` and a stub store), prints usage and
exits 2 with no arguments, and does not load `~/.config/lotl/.env`.

### 11. Loose ends

- `extractor.ts:214` cites `devnotes/metrics/local-llm-e2b-2026-11-11.md` (missing).
- `conflict.ts:47` doc says "only when a chat LLM is configured"; it runs whenever
  `getRemoteLLM()` is non-null, including embed-only.
- `LOTL_EXTRACT_PROMPT` not trimmed.
- Magic numbers: 0.5, 39, 60, 200 in the extractor; `> 10` and 0.9 in conflict.

## Wiring and defaults

- Only conflict call site in `src`: `memoryStore` (`index.ts:695-704`), via `conflictMode`,
  `resolveConflict`, `guardConflict`. CLI `memory store`, MCP `memory_store`, OpenClaw,
  `extractAndStore` and the `importMemories` fallback loop all pass through it.
- `memoryStoreBatch` has no cosine dedup and so no conflict step (documented).
- Variable unset, no provider: same as HEAD (cosine >= 0.9 is a duplicate).
- Variable unset, provider set: mode `llm`, same prompts and parsing as HEAD.

## `guarded` rules as written

- DELETE becomes ADD.
- NONE or unparsed becomes ADD if the incoming text has a specific the existing text lacks.
- UPDATE becomes ADD if the merged text is missing, drops a specific of either text, or
  invents one.
- No evidence in the tree for these rules: `conflict-set.mjs` exists, no result files.

## Test gaps

Not tested: `llm`-mode UPDATE path (hash recompute, history row, stale vector); `guarded`
UPDATE accepted; null or throwing chat in `guarded`; substring false negatives; prose-only
facts; cross-scope matches; redaction on the notes path; a part failing mid-run; style
detection on `importConversation` and OpenClaw chunk shapes; notes path driving a real
`memoryStore`.

## Docs gaps

`LOTL_MEMORY_CONFLICT`, `LOTL_EXTRACT_PROMPT`, `LOTL_EXTRACT_CHUNK_CHARS` absent from
`.env.example`, `CHANGELOG.md`, `CLAUDE.md`, `skills/lotl/SKILL.md`, `docs/`, `README.md`.
No README in `evaluate/local-llm/`.
