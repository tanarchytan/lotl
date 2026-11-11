# Gemma 4 E2B as lotl's LLM (2026-11-11)

Can the small local model Gemma 4 E2B drive lotl's LLM operations, and which guards does lotl
need before it is switched on. This file was updated after every
measurement. Anything not yet measured says so. Status: **complete** (2026-11-11); the
per-operation verdict and the env lines are at the end.

Model: `llm-light.service`, llama.cpp, Gemma 4 E2B, `http://127.0.0.1:8081/v1`, model id
`light`. lotl reaches it through the query-expansion provider:

```
LOTL_QUERY_EXPANSION_PROVIDER=api
LOTL_QUERY_EXPANSION_URL=http://127.0.0.1:8081/v1
LOTL_QUERY_EXPANSION_API_KEY=local
LOTL_QUERY_EXPANSION_MODEL=light
```

All calls `temperature 0`, `seed 42`, `max_tokens 1000` (lotl's `chatComplete`), one request at
a time. No index was opened: the harness passes a stub store to `extractAndStore`.

## Eval sets (frozen)

`evaluate/local-llm/`, frozen by sha256 on 2026-11-11 before any prompt tuning; hashes
re-checked unchanged before every run in this note.

| File | sha256 (first 12) | Cases | dev / held-out |
|---|---|---|---|
| `extraction-set.mjs` | `a2e88c030a62` | 24 | 16 / 8 |
| `conflict-set.mjs` | `fb07be9d125e` | 22 | 14 / 8 |
| `compaction-set.mjs` | `8ef0834be7bd` | 18 | 11 / 7 |

Synthetic texts modelled on real index topics; names, numbers and ids altered.

## Metric definitions

Every metric below is computed **by rule** (regexes and token checks in
`evaluate/local-llm/run.mts`). No metric is judged by a model.

### Extraction (`run.mts extract`)

Per input, `extractAndStore` runs with a stub store; the metrics read `extracted`.

- **Recall of required facts** = hits / required facts. A required fact is hit when one single
  extracted memory matches every regex in its `all` list (a rule split from its value over two
  memories is a miss).
- **Standalone** = memories matching at least one of the case's `subjects` regexes / memories
  (the memory names its project, system or person).
- **Unsupported** = memories with at least one *specific token* not found in the source text /
  memories. Specific token: a number (`\d+([.,]\d+)*`), a path-like or dotted identifier
  (`x/y`, `a.b`, `a:b`), a `snake_case`, `camelCase` or ALLCAPS (3+) word. "Found" is a
  case-insensitive substring check after decimal comma to dot. Lenient (substring) and blind
  to fabricated plain words.
- **Unsupported, facts only** (added 2026-11-11 by this study, secondary): the same, ignoring
  tokens that occur in the model's own `PROJECT:` / `TOPIC:` label lines, which lotl prefixes
  to memories that lack a subject. Separates a made-up label ("Commit/PR style") from a
  made-up fact.
- **Forbidden** = memories matching any of the case's `forbidden` regexes (fabrication traps,
  negation flips). Count, not rate.
- **Filler** = memories that are category `reflection`, or match the generic-praise regex
  `FILLER`, or the date/meta-only regex `META`, **and** fully match no required fact / memories.
- **Memories per input** = memories / inputs.
- **Duplicate pairs** = pairs of memories from one input with word Jaccard >= 0.6 (stop words
  removed).
- **Parse failures** = inputs where the LLM was called, zero memories came back, and the case
  has required facts.
- **Truncated** = inputs where a call ended with `finish_reason = length`.
- **Latency p50** = upper median of per-input wall time of `extractAndStore`, inputs with at
  least one LLM call.

### Conflict resolution (`run.mts conflict`)

Each pair is sent once through `resolveConflict` (the prompt `memoryStore` uses). Both modes are
scored **from the same model replies**: `llm` applies the reply as `memoryStore` does,
`guarded` passes the same reply through `guardConflict`. (temperature 0, so a second run would
see the same replies; checked once, see below.)

- **Effective action**: what `memoryStore` would do. `llm`: UPDATE without usable merge text =
  ADD, unparsed or null reply = NONE (duplicate). `guarded`: output of `guardConflict`.
- **Correct** = effective action is the gold action or in the case's `ok` list.
- **Existing destroyed** = effective UPDATE or DELETE when that is not correct, plus UPDATE
  whose merged text fails a `keep` regex. The existing row is gone or rewritten wrongly.
- **Incoming lost** = effective NONE when gold is not NONE (new fact dropped as duplicate).
- **Near-duplicate stored** = gold NONE, effective ADD (the price of being careful).
- **Stale kept** = gold DELETE, effective ADD (both the old and the new value stay).
- **Unparsed** = reply not exactly one of ADD / UPDATE / DELETE / NONE.

### OKF compaction (`run.mts compact`)

`compactMemoryText(text, chat)`, the same function `lotl memory compact` uses.

- **Facts kept** = `keep` regexes matching the body / all `keep` regexes.
- **All kept** = cases where every `keep` regex matches.
- **Low confidence** = `compactMemoryText` flagged it (no description, no body, or body at the
  500-char cap); such a result is not applied without `--force`.
- **Invented** = cases whose body or description has a specific token not in the source
  (same rule as extraction "unsupported").
- **Heuristic fallback** = reply was not parseable JSON, so the heuristic body was returned.

## Results

### 1. Conflict resolution (22 pairs, 14 dev + 8 held-out)

Code: after the Part A fixes (guarded = non-destructive, token rule). Two runs, identical
replies and merges in both (temperature 0 is deterministic here). Run files `c1`, `c2`.
No tuning was done on this set; dev and held-out are pooled, split shown where it matters.

What E2B answers: **UPDATE 17, ADD 5, DELETE 0, NONE 0**, unparsed 0. It never says a pair
is a duplicate and never says one supersedes the other; it merges almost everything.

| Mode | Correct (by rule) | Existing rows rewritten wrongly | Incoming lost | Near-dups stored | Stale kept |
|---|---|---|---|---|---|
| `llm` | 12/22 (54.5%) | **10/22** | 0/17 | 0/5 | 0/4 |
| `guarded` | 13/22 (59.1%) | **0/22** | **0/17** | 5/5 | 4/4 |
| `guarded`, no reply (timeout, error) | 13/22 | 0/22 | 0/17 | 5/5 | 4/4 |

By gold class, correct: `llm` ADD 3/8, UPDATE 5/5, DELETE 4/4 (via the `ok` UPDATE), NONE 0/5.
`guarded` ADD 8/8, UPDATE 5/5 (ADD is in `ok`), DELETE 0/4, NONE 0/5.
Split: `llm` dev 9/14 correct, 5 rows rewritten wrongly; held-out 3/8, 5 rewritten wrongly.
`guarded` dev 8/14, held-out 5/8, 0 rewritten, 0 lost in both.
Latency p50 0.46 to 0.63 s per pair (two calls when UPDATE).

The 10 wrong rewrites in `llm` mode: all 5 paraphrase pairs (gold NONE) were merged into the
existing row, and 5 of 8 pairs of distinct facts (gold ADD: two panels, two months, two
language rules, two ONNX models, two rules) were merged into one row. In this run every
merge still contained both sides' `keep` regexes (merge loss 0/17 by rule). Read by me, not
scored by rule: the x4 merge says "backed up daily in snapshot mode, with an exception for a
weekly stop-mode backup", which states the superseded fact as current; the u1 merge turned
the literal flag `--min-relevance 0.6` into "a minimum relevance of 0.6" (the `keep` labels
do not check the flag name, so the rule does not count it). Also, after an UPDATE the row's
vector is still the old text's (finding 8, open), so a merged-in fact is reachable by FTS
only.

`guarded` price on this set: every paraphrase is stored as a second row (5/5 gold NONE) and
every superseded value stays next to the new one (4/4 gold DELETE, e.g. both "Zitadel runs
v4.15.0" and "... v4.21.1"). Recall can surface the stale row; nothing is lost.

**Guard rule check.** The rule "drop the incoming memory only when every word token of it is
in the existing text" was tested before any model run (pure function, no LLM):
- on the 22 pairs it never drops anything: 0/17 non-duplicates dropped (zero lost facts),
  0/5 paraphrases dropped (all stored);
- review scenarios: port 80 vs 8080 kept, tea vs coffee kept, "encrypted" vs "not
  encrypted" kept.
- One change from the starting rule: the incoming text must also keep every negation word of
  the existing text (`not`, `never`, `no`, Dutch `niet`, `geen`, `nooit`, ...). Without it,
  "Backups are encrypted" arriving after "Backups are not encrypted" is a token subset and
  would be dropped, losing the contradiction. Covered by a unit test; no case in the set
  exercises it.
- No looser rule is supported: the 5 paraphrase pairs differ from their originals in content
  words (prefers/wants, passes/uses, runs/version), the same kind of one-word difference as
  tea/coffee. Any overlap threshold that drops them would also drop tea/coffee.
- Since E2B never answers NONE, `guarded` behaves the same as the rule alone on this set.

### 2. OKF compaction (18 texts, 11 dev + 7 held-out)

`compactMemoryText` with E2B vs the heuristic (first 6 lines, cut at 500 chars). One run
each (`k1`), no tuning.

| | Facts kept (by rule) | All facts kept | Low confidence (not applied) | Applied and lossy | Heuristic fallback | p50 / max |
|---|---|---|---|---|---|---|
| E2B | 52/69 (75.4%) | 6/18 | 6/18 | 6/12 applied | 1/18 (bad JSON) | 3.4 s / 7.1 s |
| heuristic | 58/69 (84.1%) | 8/18 | 18/18 | 0 | n/a | 0 s |

Split, facts kept: E2B dev 33/43, held-out 19/26; heuristic dev 34/43, held-out 24/26.

What the E2B bodies look like (rule counts):
- 17/18 bodies start with `<<=500 chars>`, the prompt's own placeholder copied into the body.
- 6/18 bodies hold a JSON object with invented keys (`"load_bearing"`, `"the one gotcha"`,
  `"file:line": "N/A"`) instead of prose.
- Invented specifics (rule, body + description): 17/18 cases, mostly the echoed `500`;
  10/18 with that token ignored (keys like `OuraAPI_Verify`, `file:line`, `Docker/DB`).
- Of the 12 results `compactMemoryText` would apply (not low confidence), 0 are clean (no
  placeholder, no JSON, every fact kept).
- Read by me, not by rule: the c13 description says the token "rotates hourly"; the source
  says every 24 h. A wrong fact the specific-token rule cannot see.

Where this matters: **nowhere in lotl today.** `memoryStore` calls
`compactMemoryText(original)` without a chat function (heuristic, always flagged draft),
and `lotl memory compact` calls `compactAllMemories(db, { apply, force })` without one too.
The LLM path is only reachable from code that passes `chat` (this harness). So E2B cannot
reach compaction through any env setting, and no switch is needed. If someone wires the
LLM into compaction later, it must not be E2B with this prompt.

### 3. Extraction (24 inputs, 16 dev + 8 held-out)

Code: final Part A code. Prompts unchanged from the previous agent's last version (it tuned
the notes prompt over seven rounds on dev; **no further prompt round was done in this
study**). Original prompt = `LOTL_EXTRACT_PROMPT=conversation` (the default), notes prompt =
`LOTL_EXTRACT_PROMPT=auto` (all 24 inputs detect as notes, one part each). One run each
(`xbase`, `xnotes`, heuristic `hcheck`/`xheur`). Held-out was already looked at once by the
previous agent; these are a second look at it, with no tuning in between.

| Split | Prompt | Recall of required facts | Standalone | Unsupported (rule) | Unsupported, facts only | Filler | Forbidden | Memories / input | p50 / max latency |
|---|---|---|---|---|---|---|---|---|---|
| dev (16) | heuristic | 6/106 (5.7%) | 3/7 | 0/7 | 0/7 | 0/7 | 0 | 0.4 | 0 s |
| dev (16) | original | 80/106 (75.5%) | 100/221 (45.2%) | 7/221 (3.2%) | 7/221 | 23/221 (10.4%) | 1 (0 *) | 13.8 | 6.1 / 16.0 s |
| dev (16) | notes | 102/106 (96.2%) | 110/110 (100%) | 0/110 | 0/110 | 0/110 | 1 | 6.9 | 3.5 / 10.1 s |
| held-out (8) | heuristic | 2/58 (3.4%) | 1/2 | 0/2 | 0/2 | 0/2 | 0 | 0.3 | 0 s |
| held-out (8) | original | 42/58 (72.4%) | 43/106 (40.6%) | 3/106 (2.8%) | 3/106 | 4/106 (3.8%) | 1 (0 *) | 13.3 | 7.3 / 12.8 s |
| held-out (8) | notes | 51/58 (87.9%) | 65/65 (100%) | 6/65 (9.2%) | **0/65** | 1/65 (1.5%) | 1 (0 *) | 8.1 | 2.9 / 8.2 s |

Parse failures 0 and truncated replies 0 in every run. Reflections: original prompt 13.6%
dev / 16.0% held-out of memories, notes 0% (the notes parser drops them).

\* Label errors found (labels not edited, numbers given both ways): the forbidden regexes
`/DNS.?rebinding guard (was|is) (added|implemented)/` (d11) and
`/LLM (is|was) used for compaction on the write path/` (h04) also match the correct negated
sentences "No DNS-rebinding guard was implemented ..." and "No LLM is used for compaction
...". Every forbidden hit of the original prompt and the held-out notes hit are these false
positives; the corrected count is in brackets. The dev notes hit is real but minor: from the
trivial input d16 it stored "lotl decision: took a break."

**The held-out 9.2% unsupported rate of the notes prompt is a label artifact, not
fabrication.** All 6 memories come from h08, where the model wrote `TOPIC: Commit/PR style`
and lotl prefixed that label to 6 memories; `Commit/PR` is not in the source, so the
path-token rule flags it. With tokens from the model's own `PROJECT:`/`TOPIC:` lines
ignored, the rate is 0/65. The label itself is wrong for one of the six ("lotl should keep
working with no cloud key" filed under "Commit/PR style"), a quality issue but not an
invented fact.

Differences between the original and notes prompt that hold on both splits: recall +20.7
points dev (n=106) and +15.5 points held-out (n=58), standalone 40-45% vs 100%, about half as
many memories, half the latency. These are well beyond what a single-label difference
moves. Dev vs held-out recall for notes (96.2% vs 87.9%) is the expected drop from tuning on
dev. Run-to-run: the original prompt gave 75.5% / 72.4% here vs 74.5% / 74.1% in the previous
agent's run with the same prompt (temperature 0 but not bit-identical across runs), so
differences of 1-2 points between runs are noise.

Long inputs (`--concat`: frozen cases joined into 4-5k-char notes, labels = union of the
parts; derived after freezing, no new labels). Notes prompt splits them into 2 to 3 parts of
at most 2500 chars, original prompt sends them whole:

| Split | Prompt | Inputs | Recall | Standalone | Unsupported | Calls | Truncated calls | Latency |
|---|---|---|---|---|---|---|---|---|
| dev | original | 2 | 41/87 (47.1%) | 34/54 | 3/54 | 2 | 1 | 19.0 s |
| dev | notes | 2 | 77/87 (88.5%) | 83/83 | 0/83 | 4 | 0 | 25.8 s |
| held-out | original | 1 | 24/58 (41.4%) | 14/32 | 0/32 | 1 | 0 | 15.1 s |
| held-out | notes | 1 | 50/58 (86.2%) | 56/58 | 0/58 | 3 | 1 | 28.2 s |

The original prompt loses about half the facts on long input (1000-token output cap, and it
drops paragraphs); the notes prompt with parts keeps recall near its short-input level. One
held-out part hit the 1000-token cap (`finish_reason=length`); its memories up to the cut
were kept. The held-out forbidden hit is the h04 label false positive again. Three inputs:
treat these as a direction, not a rate.

### 4. Query expansion (sampled: 20 queries, one run)

`RemoteLLM.expandQuery` (the prompt lotl uses, temperature 0.7) on 20 hand-written queries
about the eval-set topics, one of them a single word ("deploy"). A sample, not a labelled
set. Script: scratch `qe.mts`, not in the repo.

- Format and reliability: 20/20 replies had all three lines (lex, vec, hyde), 0 fallbacks,
  0 errors. Latency p50 0.49 s, max 0.72 s.
- Content (rule): the lex line repeats the query's own words in 14/20 and adds a new term in
  only 2/20 (one of them "keyword terms", copied from the prompt). vec repeats the query in
  9/20, hyde in 8/20; in 6/20 every line is the query again. Prompt text leaks into 5/20
  ("semantic search query for ...", "hypothetical document snippet about ...", "keyword
  terms").
- Memory recall uses only the lex line, so with E2B it adds a near-copy of the query and
  sometimes junk words, for about 0.5 s per recall that has no strong FTS hit. That includes
  the recall hook when it runs `memory recall` (`LOTL_OKF=off`); the OKF branch passes
  `rerank: false` and never expands.

Verdict: unfit. There was no way to keep the provider for extraction and turn expansion off,
so this study added `LOTL_QUERY_EXPANSION=off` (`src/remote-config.ts`
`queryExpansionEnabled`, checked in `store/search.ts` `expandQuery` and in `memoryRecall`;
test `test/query-expansion-switch.test.ts`).

## Where lotl calls an LLM

One chat provider serves every chat operation: `LOTL_QUERY_EXPANSION_*`
(`getRemoteLLM()` in `src/remote-config.ts`). Setting it switches on all rows marked
"QE provider" at once. Embeddings and rerank have their own providers.

| Operation | Code | Triggered by | Provider | Off switch |
|---|---|---|---|---|
| Query expansion, documents | `store/search.ts` `expandQuery` | `lotl query` / `vsearch`, MCP `query` | QE provider | `LOTL_QUERY_EXPANSION=off` (new, this study); skipped on a strong BM25 hit |
| Query expansion, memories | `memory/index.ts` `memoryRecall` (lex lines only) | `lotl memory recall` (recall hook when `LOTL_OKF=off`), MCP `memory_search`, OpenClaw auto-recall | QE provider | skipped on a strong FTS hit, `LOTL_QUERY_EXPANSION=off` (new, this study), `LOTL_RECALL_RAW=on` (also drops boosts), `rerank: false` (passed by `okf recall`, so the OKF hook branch never expands) |
| Extraction | `memory/extractor.ts` `extractWithLLM` | MCP `memory_extract` (the Stop hook asks the agent to call it), `lotl memory extract`, `lotl memory import` of conversations, OpenClaw auto-capture | QE provider | none but unsetting the provider (then heuristic); `LOTL_EXTRACT_PROMPT` picks the prompt |
| Conflict resolution | `memory/index.ts` `resolveNearDuplicate` | every `memoryStore` whose text has a same-scope neighbour at cosine >= 0.9 (needs embeddings, e.g. `LOTL_ONNX=on`): `memory_add`, `lotl memory store`, each extracted memory, OpenClaw | QE provider (any remote provider makes it run; embed-only gets a null reply) | `LOTL_MEMORY_CONFLICT=off` (or `guarded`) |
| Reflect synthesis | `memoryReflect` | MCP `memory_reflect`, OpenClaw reflect tool | QE provider | only on explicit call |
| Reflection pass | `runReflectionPass` | MCP `memory_dream`, `lotl dream`, OpenClaw nightly dream gate | QE provider | only on explicit call / dream gate; no env switch |
| OKF compaction, LLM path | `okf/budget.ts` `compactMemoryText(text, chat)` | **nothing**: `memoryStore` and `lotl memory compact` pass no `chat` | n/a | n/a (heuristic only) |
| Rerank, LLM mode | `llm/remote.ts` `rerank` | memory / document rerank when `LOTL_RERANK_PROVIDER=api` | `LOTL_RERANK_*` (separate) | `LOTL_MEMORY_RERANK`, `LOTL_RERANK_MODE` |
| Embeddings | `llm/remote.ts` `embed` | store, recall | `LOTL_EMBED_*` (separate) or local ONNX | `LOTL_ONNX`, `LOTL_EMBED_BACKEND` |

Not measured with E2B: reflect synthesis, the reflection pass, LLM-mode rerank.
`~/.config/lotl/.env` wins over the process env for `LOTL_*` vars, so the lines below
belong in that file, not in a shell profile.

## Verdict per operation

| Operation | E2B result (n) | Verdict |
|---|---|---|
| Extraction, notes prompt (`LOTL_EXTRACT_PROMPT=auto`) | recall 102/106 dev, 51/58 held-out; standalone 100%; invented facts 0/110 dev, 0/65 held-out (rule, labels excluded); p50 3 s per input; long notes 77/87 and 50/58 in parts. Heuristic today: 6/106 and 2/58 | **use** (only together with `LOTL_MEMORY_CONFLICT=guarded`, because every extracted memory goes through the conflict step) |
| Extraction, original prompt | recall 80/106, 42/58; standalone 41-45%; 10% filler dev; long input 41/87, 24/58 | do not use for notes; `auto` still sends real chat transcripts to it (not measured on transcripts) |
| Conflict resolution, `llm` | UPDATE on 17/22, never NONE or DELETE; 10/22 existing rows rewritten wrongly | **do not use** |
| Conflict resolution, `guarded` | 0/22 rows rewritten, 0/17 new facts lost; 5/5 paraphrases and 4/4 superseded values kept as extra rows | **use only with guard**. The guard rule does the work: E2B's reply never changes the outcome on this set, so each near-duplicate costs one call (~0.5 s) for nothing. |
| OKF compaction | 52/69 facts kept vs heuristic 58/69; prompt placeholder in 17/18 bodies, JSON in 6/18, 0/12 applied results clean | **do not use**. Not reachable today: no caller passes a chat function. No setting needed. |
| Query expansion | 20/20 well-formed, p50 0.49 s, but lex adds a term in 2/20, echoes in 14/20, prompt leaks in 5/20 (sample) | **do not use**: `LOTL_QUERY_EXPANSION=off` |
| Reflect synthesis, reflection pass | not measured | unknown. They only run on explicit calls (`memory_reflect`, `memory_dream`, `lotl dream`) or the OpenClaw nightly dream gate, which would store E2B reflections as memories without review. |

Lines for `~/.config/lotl/.env` (that file wins over the process env for `LOTL_*`):

```
LOTL_QUERY_EXPANSION_PROVIDER=api
LOTL_QUERY_EXPANSION_URL=http://127.0.0.1:8081/v1
LOTL_QUERY_EXPANSION_API_KEY=local
LOTL_QUERY_EXPANSION_MODEL=light
LOTL_MEMORY_CONFLICT=guarded
LOTL_EXTRACT_PROMPT=auto
LOTL_QUERY_EXPANSION=off
```

All three switches must be in place before the provider lines take effect: the provider
alone puts E2B on the destructive `llm` conflict path for every near-duplicate store and on
query expansion for every recall. The global install must be rebuilt from this tree first;
the installed 1.2.0-alpha.2 does not know `guarded`, `auto` or `LOTL_QUERY_EXPANSION` (an
older build would treat `guarded` as `llm`).

When `llm-light.service` is down: extraction falls back to the heuristic (as without a
provider), `guarded` applies the token rule alone. Each call can wait up to the 60 s generate
timeout with retries, so a hung server slows `memory_extract` and stores.

## Open

- Finding 8 (pre-existing): after an `llm`-mode UPDATE the row keeps the old text's vector;
  only the text is in `memory_history`. Not reachable in `guarded`.
- Exact-hash dedup (`content_hash`) is still cross-scope: the same text stored in a second
  scope answers `duplicate` of the first scope's row. Same class as finding 7, not changed.
- `guarded` keeps superseded values next to new ones (4/4 here). Recall may show the stale
  one; nothing marks it superseded.
- Reflect and the reflection pass are not measured with E2B.
- Two forbidden labels match correct negated sentences (d11, h04); a v2 extraction set
  should fix them.
- The `--min-relevance` flag name was lost in one `llm`-mode merge (u1) without the `keep`
  labels noticing; merge quality is only partly covered by rule.

## Heuristic extraction

Added 2026-11-11, after the study above. Without an LLM, `extractAndStore` falls back to
`extractHeuristic`. Before this change that kept only sentences matching the chat-style
patterns in `patterns.ts` ("I prefer", "we decided"), which session notes almost never
use: 6/106 required facts on dev. Notes input now goes to `src/memory/notes-heuristic.ts`;
speaker-turn transcripts (`detectExtractStyle`) keep the old rule. No LLM is involved
anywhere in this section.

Same harness and metric definitions as section 3 (`run.mts extract --mode heuristic`, stub
store). "Before" was re-run from a `git archive HEAD` copy of `src/` (identical to the
earlier "Heuristic" rows). Tuned on dev only. Held-out was run once with the final rules (the long held-out input
twice, same code, same result). After that, two words were removed from the filler list
for a reason unrelated to the scores; dev and held-out were re-run once to confirm the
memories are identical, and they are. Nothing was tuned after the held-out run.
Set hashes unchanged (`a2e88c030a62`).

| Split | Version | Recall of required facts | Standalone | Unsupported (rule) | Forbidden | Filler | Memories / input |
|---|---|---|---|---|---|---|---|
| dev (16) | before | 6/106 (5.7%) | 3/7 | 0/7 | 0 | 0/7 | 0.4 |
| dev (16) | after | **106/106 (100%)** | 76/76 | 0/76 | 0 | 0/76 | 4.8 |
| held-out (8) | before | 2/58 (3.4%) | 1/2 | 0/2 | 0 | 0/2 | 0.3 |
| held-out (8) | after | **57/58 (98.3%)** | 38/40 (95.0%) | 0/40 | 1 (0 *) | 0/40 | 5.0 |
| dev, long (`--concat`, 2) | before | 6/87 | 3/6 | 0/6 | 0 | 0/6 | 3.0 |
| dev, long (`--concat`, 2) | after | 83/87 (95.4%) | 61/61 | 0/61 | 0 | 0/61 | 30.5 |
| held-out, long (1) | before | 2/58 | 1/2 | 0/2 | 0 | 0/2 | 2.0 |
| held-out, long (1) | after | 57/58 | 43/43 | 0/43 | 1 (0 *) | 0/43 | 43.0 |

\* The forbidden-label false positive described in section 3 (a forbidden regex that also
matches the correct negated sentence). The heuristic copies that sentence verbatim.

For comparison, the notes prompt with E2B (section 3): 102/106 at 6.9 per input on dev,
51/58 at 8.1 on held-out; long inputs 77/87 and 50/58. Duplicate pairs 0 in every heuristic
run.

Read this recall with care. Unsupported is 0 by construction: every memory is the notes'
own text plus a subject prefix taken from the notes. But the memories are longer than the
model's (mean 145 chars on dev, longest 346, prefix included), and on these dense
summaries the heuristic keeps nearly everything: 1817 of 1903 source word tokens on dev
appear in some memory (diagnostic, not one of the defined metrics). The gain over the old
rule comes from segmentation and the subject prefix, not from picking the important
sentences. Volume stays below the notes prompt because adjacent short sentences, lists
and table rows are grouped.

### Rules

1. Title: a first line `PROJECT: x`, a first-line heading, or a first sentence of at most
   8 words (dates and brackets left out) that has a notes word (session, summary, notes,
   handoff, sessie, ...) or ends in a date, and does not start with an article or
   pronoun. Generic words are trimmed from its comma segments; the first segment left is
   the subject. The title is not stored. No title: a capitalised name that occurs at
   least twice is the subject.
2. Blocks at headings (heading text becomes the topic) and blank lines.
3. Pieces: sentences, list items, table rows. A list is joined to a lead-in line ending
   in `:`; a table row to its header row. Code fence lines are dropped.
4. Dropped pieces: `META_ONLY`, thanks and similar remarks about the session without a
   number or identifier, and pieces under 20 chars without one.
5. Packing: adjacent pieces of a block are joined while the memory stays under 160
   chars; a piece opening with a back-reference (That, It, So, He, Dat, Hij, ...) stays
   with the one before up to 360 chars; one sentence over 360 is cut at `; `, then `, `.
6. Memories with no informative token (number, path, file name, snake/camel/ALLCAPS or
   hyphenated identifier, flag, backtick), no rule word (decision, prefer, never, not,
   besluit, niet, nog niet, ...) and no name used elsewhere in the notes are dropped. At
   most 16 per 2500 chars of notes are kept, highest count of such signals first,
   then restored to note order.
7. `withSubject` (shared with the LLM notes parser, now in `notes-subject.ts`) prefixes
   subject and topic when the memory lacks them. Category: label words (Decision,
   Besluit, prefers) first, then `classifyMemory`, else `fact`.

The same function is the fallback for a failed part in LLM notes mode; it now receives
the subject from the whole note's title, since a later part has none.

### What was tried

Sweep on dev, final rules, packing target x per-part cap (hard cap 360 throughout):

| Packing target | Cap per 2500 chars | Recall | Memories / input | Mean length |
|---|---|---|---|---|
| 0 (one sentence each) | 16 | 102/106 | 5.3 | 130 |
| 120 | 16 | 103/106 | 5.1 | 134 |
| **160** | **16** | **106/106** | **4.8** | **145** |
| 160 | 12 | 104/106 | 4.6 | 147 |
| 160 | 8 | 100/106 | 4.3 | 146 |
| 200 | 16 | 106/106 | 4.3 | 159 |
| 240 | 16 | 106/106 | 3.7 | 183 |
| 320 | 16 | 106/106 | 3.1 | 213 |

- Packing past 160 buys no recall here, only longer memories; below 160 it splits facts
  whose rule and value sit in adjacent sentences. Recall stops paying at about 160.
- The cap only binds on the longest dev input (about 2.3k chars, 15 memories kept at
  16): 12 loses 2 facts there, 8 loses 6. Ranking by signal count cannot tell which
  sentence of a dense summary matters, so a tighter cap trades facts one for one.
- An earlier version cut every sentence at the packing target (no separate hard cap):
  at 120 chars it fell to 90/106 by splitting sentences at commas.
- The informativeness filter (rule 6) dropped real facts in its first form (three dev
  sentences with a plain-word name or a hyphenated identifier and no number); adding
  hyphenated identifiers and names used elsewhere in the notes brought that to zero
  drops on dev. On these sets the filter removes nothing; it acts on whole packed memories,
  so it only drops a paragraph with no number, identifier, rule word or name.
- Back-reference gluing fixed pronoun-only memories (a sentence starting "He ..." stored alone) that the
  standalone metric flagged.

### What it still misses

- A fact split over two memories at a packing boundary: one held-out fact (a rule and
  its condition in neighbouring sentences); 4 of 87 on the long dev input.
- A title it does not recognise (a date in the middle, no notes word): the memories get no
  subject. Two held-out memories, both from one input.
- Selection. The heuristic cannot tell routine status from a decision, so on chattier
  notes it will store more than a model would. Not measured: the set has one trivial
  input (0 memories, correct) and no chatty ones.
- Conversation-style input is unchanged and was not measured: every input of this set
  detects as notes, and no labelled transcript set is local. A one-line chat such as
  `User: ... Assistant: ...` (one prefix, no repeated speaker) detects as notes and now
  gets the notes heuristic.
