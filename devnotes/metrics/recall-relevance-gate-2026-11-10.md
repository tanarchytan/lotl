# Recall relevance gate (2026-11-10)

Why `--min-relevance` exists, how the default (0.6) was picked, and how far to trust it.

## Problem

The `UserPromptSubmit` recall hook sends the whole prompt to a keyword recall and
injects the top rows. Recall scores are RRF ranks pushed through boosts, so they
rank candidates but carry no absolute meaning: a relevant and an irrelevant prompt
both come back with top scores around 0.01 to 0.02. The FTS query is an OR of every
non-stopword term with prefix matching, so almost any prompt matches something.
Measured before the change, the hook injected about 10 rows on 90 of 91 labelled
prompts, including every off-topic and conversational one.

## Labelled set

All measurements ran on a read-only scratch copy of the real index (1,626 memories,
32 scopes) with `LOTL_RECALL_NO_TOUCH=on`. The set itself stays outside the repo
because the on-topic prompts describe private project work.

| Split | On-topic (a) | Off-topic (b) | Short conversational (c) | Long generic instruction (d) | Total |
|---|---|---|---|---|---|
| dev | 29 | 10 | 12 | 8 | 59 |
| held-out | 12 | 6 | 8 | 6 | 32 |

- (a) prompts were written after reading memories in 19 scopes (including
  `global`), each labelled with the memory ids that answer it (1 to 3 per prompt).
  Held-out (a) includes 5 cross-scope prompts (typed in one project's directory,
  answered by another project's memory) and one Dutch prompt. Dev (a) has none.
- (b) general knowledge questions, (c) turns like "send it", "continue", "ok looks
  good, next", "why did that fail?", (d) long coding instructions that share only
  common words with memories. None of (b), (c), (d) should inject anything.

Metrics, per prompt: an (a) prompt is a success when at least one labelled id is
injected. Precision = successes / prompts that injected anything. Recall =
successes / (a) prompts. "Empty" = share of prompts that inject nothing (ideal: 0.51
dev, 0.62 held-out, 0.55 pooled). Labels are conservative: unlabelled but related
rows count as misses, so precision is a lower bound.

## Candidates

Signals computed per candidate memory from the default recall pool (gate applied
before the top-10 cut, original order kept). "Informative terms" = prompt tokens
split on non-alphanumerics, minus the recall stopwords and a fixed list of
acknowledgements and generic coding-session words (`src/memory/relevance.ts`).
Coverage = IDF-weighted share of the informative terms found in the memory text
column (IDF over the whole memory table; unknown terms count in the denominator).

| Candidate | dev (59) P / R / empty | held-out (32) | pooled (91) | negatives injected (pooled) |
|---|---|---|---|---|
| No gate (top 10 as today) | 0.31 / 0.62 / 0.00 | 0.22 / 0.58 / 0.00 | 0.27 / 0.61 / 0.00 | 50 |
| C1 prompt has >= 2 informative terms | 0.38 / 0.62 / 0.20 | 0.27 / 0.58 / 0.19 | 0.34 / 0.61 / 0.20 | 32 |
| C2 IDF coverage >= 0.6 | 0.93 / 0.97 / 0.49 | 0.80 / 1.00 / 0.53 | 0.89 / 0.98 / 0.51 | 5 |
| C3 raw FTS5 bm25 >= 15 (no word list) | 0.93 / 0.93 / 0.51 | 1.00 / 1.00 / 0.62 | 0.95 / 0.95 / 0.55 | 1 |
| C4 >= 2 matched rare terms (df <= 2%) | 0.83 / 0.83 / 0.51 | 0.80 / 1.00 / 0.53 | 0.82 / 0.88 / 0.52 | 8 |
| C5 matched IDF mass >= 10 | 0.94 / 1.00 / 0.47 | 0.75 / 1.00 / 0.50 | 0.87 / 1.00 / 0.48 | 6 |
| **Chosen**: C1 + C2 + >= min(3,#terms) matched | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.98 / 0.98 / 0.55 | 1 |
| Chosen + hard cwd scope (scope + global) | 1.00 / 0.97 / 0.53 | 0.88 / 0.58 / 0.75 | 0.97 / 0.85 / 0.60 | 0 |
| Chosen + soft cwd scope (scope rows first) | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.98 / 0.98 / 0.55 | 1 |

Notes:

- Without the generic word list, coverage alone tops out at P 0.72 (dev, threshold
  0.7). The list carries most of the weight on conversational prompts.
- Coverage alone leaks two ways: a one-term prompt ("show me the output") gives any
  memory containing that term coverage 1.0, and long handoff-style memories cover
  2 of 3 rare terms by chance. The term floor and the distinct-match rule close both.
- bm25 >= 15 is the best single knob and needs no word list, but its scale moves with
  corpus size and prompt length, and its sensitivity is sharp (12: P 0.78, 18: R 0.85).
  Coverage is normalised per prompt and degrades more gently (table below).
- Recall rises above the ungated hook because gating before the top-10 cut lets a
  relevant memory at rank 15 to 80 surface once the noise above it is dropped.

## Threshold sensitivity (chosen rule)

| coverage threshold | dev P / R / empty | held-out | pooled | pooled rows per injecting prompt |
|---|---|---|---|---|
| 0.3 | 0.90 / 0.97 / 0.47 | 0.75 / 1.00 / 0.50 | 0.85 / 0.98 / 0.48 | 4.7 |
| 0.4 | 0.93 / 0.97 / 0.49 | 0.92 / 1.00 / 0.59 | 0.93 / 0.98 / 0.53 | 4.4 |
| 0.5 | 0.97 / 0.97 / 0.51 | 0.92 / 1.00 / 0.59 | 0.95 / 0.98 / 0.54 | 3.2 |
| 0.6 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.98 / 0.98 / 0.55 | 2.5 |
| 0.7 | 0.96 / 0.93 / 0.53 | 1.00 / 0.92 / 0.66 | 0.97 / 0.93 / 0.57 | 2.1 |
| 0.8 | 0.96 / 0.83 / 0.58 | 1.00 / 0.92 / 0.66 | 0.97 / 0.85 / 0.60 | 1.5 |
| 0.9 | 0.95 / 0.69 / 0.64 | 1.00 / 0.67 / 0.75 | 0.97 / 0.68 / 0.68 | 1.3 |

0.5 to 0.7 is a plateau; 0.6 is its middle. Below 0.4 precision drops, above 0.7
recall drops.

## Scope from cwd: not shipped

`memoryRecall` with `scope` already includes `global` (`passesFilters`). Mapping the
hook's cwd basename to a scope (lowercase, spaces to dashes, unscoped when no scope
matches) was tried two ways. Hard preference fixed the one remaining dev leak but cut
held-out recall from 1.00 to 0.58, because people ask about other projects from
whatever directory they are in. Soft preference (cwd-scope rows first) changed
nothing measurable. Neither earned a flag.

## Chosen defaults

- Prompt needs >= 2 informative terms (`MEMORY_RELEVANCE_MIN_TERMS`), else recall
  returns [] before any search.
- A memory needs >= min(3, #terms) distinct informative terms in its text
  (`MEMORY_RELEVANCE_MIN_MATCHES`) and coverage >= `--min-relevance` (hook: 0.6).
- Order of the surviving rows is the ungated order. Sorting by coverage raised
  "labelled hit in the first 3 rows" from 0.83 to 0.93 on dev, but was left out to
  keep ranking untouched; worth revisiting if hooks start injecting more rows.

## End to end (built CLI through the hook, scratch copy of the real index)

| Hook config | P / R / empty (91) | negatives injected | rows per injecting prompt | wall, 10 prompts (median) |
|---|---|---|---|---|
| before, memory branch (installed hook, lotl 1.2.0-alpha.2) | 0.28 / 0.61 / 0.01 | 49 | 9.9 | 388 ms |
| before, OKF branch | 0.38 / 0.83 / 0.01 | 49 | 8.0 | 1090 ms |
| after, memory branch | 0.98 / 0.98 / 0.55 | 1 | 2.5 | 106 ms |
| after, OKF branch | 0.95 / 0.95 / 0.55 | 1 | 2.4 | 105 ms |
| after, OKF branch, gate off | 0.24 / 0.54 / 0.01 | 49 | 7.9 | about 117 ms |

The "before" OKF branch scored higher recall than the memory branch because it was
not FTS-only: `LOTL_ONNX=on` in `~/.config/lotl/.env` overrides the hook's
`LOTL_ONNX=off`, so the embedder and cross-encoder loaded on every prompt. The hook
now also sets `LOTL_EMBED_BACKEND=off` and `LOTL_MEMORY_RERANK=off`; that, not the
gate, is where the time went. The gate's own cost is within noise. Timings were
taken on a machine with load average around 5, so read them as relative. The
remaining leak is a long generic instruction about CSV files typed in a project
whose handoff memories mention CSV parsing. OKF misses one more positive than the
memory branch because its limit is 8, not 10.

## How far to trust this

- The word list was written after the dev prompts existed, from category lists rather
  than from the negatives, but some fitting is likely. The held-out split was written
  with the list and the 0.6 threshold frozen. One decision used held-out evidence:
  adding the 2-term floor after two one-term leaks there (it was a listed candidate
  from the start). So held-out numbers for the chosen rule are mildly optimistic.
- 91 prompts, 41 positive. One prompt moves pooled precision or recall by 1 to 2.5
  points.
- The labelled mix is about half on-topic. A real session is mostly (c) and (d)
  turns, where the gate now injects nothing on this set, so live precision should be
  at least as good, but live recall on oddly worded on-topic prompts is untested.
- English only, apart from one Dutch prompt. Dutch generic words are not in the
  list, so Dutch chatter will leak more than English.
- Memories that are long multi-topic handoffs are the main source of residual
  false positives.

Scripts and raw outputs lived in the session scratchpad (feature dump via
`memoryRecall` + per-term FTS5 queries, Python sweep, hook end-to-end driver).


## Follow-up 2026-11-11: specificity floor for short common-word prompts

### Problem

Live, short turns built from words that are common in this index still injected
unrelated memories, and raising `--min-relevance` did not help:

- "claude code rebooted": 4 unrelated rows (0753e4d3, 7dee0178, 7f5102ee, 0577c979),
  identical at r = 0.6, 0.7 and 0.8.
- "claude restarted": 3 rows, one relevant (82188d67, the MCP-server restart note),
  two unrelated (5229acc3, 00b2e310).

### Diagnosis (scratch copy of the index, 1,626 memories, same rows as 2026-11-10)

- The hypothesis "the surviving terms are common" is only half right. "code" is
  already on the generic list, so the gate saw two terms: `claude` (df 132, 8.1%) and
  `rebooted` (df 25, 1.5%); for the second prompt `claude` and `restarted` (df 15,
  0.9%). Only one of each pair is common.
- The real mechanism is that a two-term prompt makes coverage binary: a memory holds
  0, 1 or 2 of the terms, so any memory holding both scores 1.0 and the threshold is
  irrelevant. The distinct-match rule asks for min(3, 2) = 2 terms, so it adds nothing.
  Under independence about 2.0 memories would hold `claude` and `rebooted` by chance
  (1626 x 0.081 x 0.015); 5 do, the leaked rows hold the two words 9 to 178 tokens apart.
- `rebooted` matched "reboots" through the FTS5 `porter` tokenizer (both stem to
  `reboot`), not through prefix matching: the gate queries `text : "term"` without
  `*`. Stemming is wanted here; it is not the cause.
- The relevant row differs from the noise only by adjacency: 82188d67 has "restart
  Claude" side by side, and no other memory does.

### New split (frozen before tuning)

Written and labelled from the data before any candidate was evaluated; prompt texts
and labels were frozen with a checksum. 54 prompts:

- 32 session-chatter prompts of 2 to 5 words built from words that are frequent here
  (tool, project and dev-verb words, 5 of them Dutch). Expected: inject nothing. For 5
  of them a memory is acceptable but not required (counted neither as a leak nor as a
  hit when it is the only thing injected).
- 5 chatter prompts with a genuine answer (the restart note for the "claude restarted"
  style prompts, a deploy recipe for "deploy to prod").
- 17 short on-topic prompts (3 to 5 informative terms after the word list) aimed at one
  or a few memories.

Adjusted after freezing, said plainly: the first sweep showed that none of the 17
on-topic prompts reduced to exactly two informative terms, the class every candidate
acts on. A second split of 16 two-word on-topic prompts (rare pairs and "common project
name + specific term" pairs such as `whoop spo2`) was written and labelled before
looking at how candidates scored it, then frozen, and is reported separately as
"two-word on-topic". It was used for the decision. Labels for the first split were not
changed.

### Candidates

Simulation over the hook's real candidate pool (FTS top 100, gate before the top-10
cut, memory branch). The current rule reproduces the 2026-11-10 numbers exactly.
"Chatter injecting" counts chatter prompts that injected something other than an
acceptable memory. "Junk rows" counts injected rows that are neither labelled hits nor
acceptable, over both new splits.

| Candidate | old dev (59) P / R / empty | old held-out (32) | new (54) | chatter injecting | chat-with-answer R | short on-topic R | two-word on-topic R | junk rows (new+new2) |
|---|---|---|---|---|---|---|---|---|
| No gate (top 10) | 0.31 / 0.62 / 0.00 | 0.22 / 0.58 / 0.00 | 0.26 / 0.64 / 0.00 | 32/32 | 2/5 | 12/17 | 12/16 | 638 |
| Current rule (2026-11-10), R 0.6 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.58 / 0.95 / 0.31 | 15/32 | 5/5 | 16/17 | 16/16 | 87 |
| (a) + matched IDF mass >= 10 (C5, fixed) | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.95 / 0.82 / 0.65 | 1/32 | 2/5 | 16/17 | 7/16 | 7 |
| (a) + mass >= 7 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.80 / 0.91 / 0.52 | 5/32 | 4/5 | 16/17 | 14/16 | 26 |
| (a') + mass >= ln N + 1 (corpus-relative) | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.90 / 0.82 / 0.63 | 2/32 | 2/5 | 16/17 | 13/16 | 9 |
| (b) drop terms with DF share > 3% | 0.96 / 0.83 / 0.58 | 1.00 / 0.92 / 0.66 | 0.94 / 0.77 / 0.67 | 1/32 | 2/5 | 15/17 | 12/16 | 9 |
| (b) drop terms with DF share > 5% | 0.93 / 0.90 / 0.53 | 1.00 / 1.00 / 0.62 | 0.86 / 0.82 / 0.61 | 3/32 | 2/5 | 16/17 | 13/16 | 17 |
| (b) drop terms with DF share > 10% | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.68 / 0.95 / 0.41 | 10/32 | 5/5 | 16/17 | 14/16 | 53 |
| (b') DF share > 5% kept in coverage, not counted as terms | 0.93 / 0.90 / 0.53 | 1.00 / 1.00 / 0.62 | 0.86 / 0.82 / 0.61 | 3/32 | 2/5 | 16/17 | 13/16 | 17 |
| (c) >= 1 matched term with DF share <= 1% | 1.00 / 0.72 / 0.64 | 1.00 / 1.00 / 0.62 | 0.83 / 0.91 / 0.54 | 4/32 | 4/5 | 16/17 | 14/16 | 22 |
| (c) >= 1 matched term with DF share <= 2% | 1.00 / 0.93 / 0.54 | 1.00 / 1.00 / 0.62 | 0.67 / 0.91 / 0.43 | 10/32 | 4/5 | 16/17 | 16/16 | 47 |
| (d) (b) 5% + (c) 2% | 1.00 / 0.90 / 0.56 | 1.00 / 1.00 / 0.62 | 0.90 / 0.82 / 0.63 | 2/32 | 2/5 | 16/17 | 13/16 | 16 |
| (d) (a') + (c) 2% | 1.00 / 0.93 / 0.54 | 1.00 / 1.00 / 0.62 | 0.90 / 0.82 / 0.63 | 2/32 | 2/5 | 16/17 | 13/16 | 9 |
| (e) two-word prompts: lift O/E >= 4 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.83 / 0.86 / 0.57 | 4/32 | 3/5 | 16/17 | 15/16 | 35 |
| (f) two-word prompts: words adjacent (span <= 1) | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.75 / 0.95 / 0.48 | 7/32 | 5/5 | 16/17 | 7/16 | 33 |
| **Chosen**: (a') + unique-phrase credit 2.5 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 16/16 | 9 |

Reading the table:

- (b) and (c), the DF-share rules, are dominated. Dropping or not counting terms above a
  DF share fixes chatter only at shares (3 to 5%) where old dev recall falls by 2 to 4
  of 29 prompts and two-word recall by 3 to 4 of 16. A rare anchor (c) at 1% loses 7 old dev prompts.
- (a') the corpus-relative IDF floor alone keeps the old 91 unchanged and cuts chatter to
  2, but drops two-word prompts made of a common word plus a mid-rare word
  ("claude restarted", "whoop spo2", "noop spo2"), which look exactly like the chatter.
- What separates those positives from the chatter is adjacency of the two words in the
  answering memory and nowhere else. Adjacency alone (f) admits common collocations
  ("git pull", "whoop data"), so the credit is only given when the phrase is unique in the
  index, and only lowers the floor rather than replacing it ("server logs" is adjacent in
  one memory but its words are too common to clear even the lowered floor).

### Chosen rule

On an index of >= 100 memories (`LOTL_MEMORY_RELEVANCE_MIN_CORPUS`), a memory that
passes the 2026-11-10 rule must also satisfy

    sum of idf(t) over matched informative terms >= ln(N) + 1.0      (LOTL_MEMORY_RELEVANCE_MIN_SPECIFICITY)

With idf close to ln(N/df), this says the matched combination would occur in fewer than
about e^-1 = 0.4 memories by chance. For a two-term prompt, the one memory (if exactly
one) that holds both terms side by side (FTS5 `NEAR(a b, 0)`, either order) gets the
floor lowered by 2.5 (`LOTL_MEMORY_RELEVANCE_PHRASE_CREDIT`). One extra FTS query per
two-term prompt, none otherwise. No word list and no language knowledge: it uses only
document frequencies of the index being searched.

Floor and credit sensitivity (r = 0.6):

| floor c (nats over ln N) | phrase credit | old dev | old held-out | new | chatter | chat-ans | short | two-word | junk |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 0 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.86 / 0.82 / 0.61 | 3/32 | 2/5 | 16/17 | 14/16 | 13 |
| 0.5 | 2.0 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.87 / 0.91 / 0.57 | 3/32 | 4/5 | 16/17 | 16/16 | 13 |
| 0.5 | 2.5 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.87 / 0.91 / 0.57 | 3/32 | 4/5 | 16/17 | 16/16 | 13 |
| 0.5 | 3.0 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.83 / 0.91 / 0.56 | 4/32 | 4/5 | 16/17 | 16/16 | 14 |
| 0.5 | 3.5 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.83 / 0.91 / 0.56 | 4/32 | 4/5 | 16/17 | 16/16 | 14 |
| 1.0 | 0 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.90 / 0.82 / 0.63 | 2/32 | 2/5 | 16/17 | 13/16 | 9 |
| 1.0 | 2.0 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 15/16 | 9 |
| 1.0 | 2.5 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 16/16 | 9 |
| 1.0 | 3.0 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 16/16 | 9 |
| 1.0 | 3.5 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.87 / 0.91 / 0.57 | 3/32 | 4/5 | 16/17 | 16/16 | 10 |
| 1.5 | 0 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.90 / 0.82 / 0.63 | 2/32 | 2/5 | 16/17 | 13/16 | 9 |
| 1.5 | 2.0 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 14/16 | 9 |
| 1.5 | 2.5 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 15/16 | 9 |
| 1.5 | 3.0 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 16/16 | 9 |
| 1.5 | 3.5 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 16/16 | 9 |

The plateau is floor 1.0 to 1.5 with credit 2.5 to 3.0 at floor 1.0 (3.0 to 3.5 at 1.5).
1.0 / 2.5 sits in it; the old 91 do not move anywhere in the table.

Coverage threshold with the chosen floor (the hook keeps 0.6):

| R | old dev | old held-out | new | chatter | chat-ans | short | two-word | junk |
|---|---|---|---|---|---|---|---|---|
| 0.4 | 0.97 / 1.00 / 0.49 | 0.92 / 1.00 / 0.59 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 16/16 | 10 |
| 0.5 | 0.97 / 0.97 / 0.51 | 0.92 / 1.00 / 0.59 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 16/16 | 10 |
| 0.6 | 0.97 / 0.97 / 0.51 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 16/16 | 9 |
| 0.7 | 0.96 / 0.93 / 0.53 | 1.00 / 0.92 / 0.66 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 16/16 | 9 |
| 0.8 | 0.96 / 0.83 / 0.58 | 1.00 / 0.92 / 0.66 | 0.90 / 0.86 / 0.61 | 2/32 | 4/5 | 15/17 | 16/16 | 7 |

### Small indexes

DF statistics mean little on a handful of memories. Re-running both rules on random
sub-corpora that keep each prompt's labelled memories (5 seeds per size, all 161
prompts):

| memories | current: on-topic recall, chatter leaking | with floor, no size guard |
|---|---|---|
| 5 | 0.95, 0.01 | 0.86, 0.00 |
| 10 | 0.97, 0.01 | 0.91, 0.00 |
| 25 | 0.97, 0.01 | 0.94, 0.01 |
| 50 | 0.97, 0.04 | 0.95, 0.02 |
| 100 | 0.97, 0.06 | 0.97, 0.04 |
| 200 | 0.97, 0.07 | 0.96, 0.04 |
| 400 | 0.97, 0.12 | 0.96, 0.06 |
| 800 | 0.97, 0.15 | 0.96, 0.04 |

Below 100 memories the leak barely exists and the floor costs 2 to 9 points of recall,
so it is skipped there (the 2026-11-10 rule applies unchanged). A test pins that a
five-memory index still answers a two-term prompt whose second word appears in two of
the five memories.

### The word list and Dutch

The floor needs no word list, but it does not replace the list. With the list removed
(recall stopwords only), the chosen rule gets old dev to 0.90 / 0.93 (with list 0.97 /
0.97), and a floor of ln N + 2 is needed to bring chatter down to 2 of 32, at a cost of 4
two-word prompts:

| Candidate | old dev (59) P / R / empty | old held-out (32) | new (54) | chatter injecting | chat-with-answer R | short on-topic R | two-word on-topic R | junk rows (new+new2) |
|---|---|---|---|---|---|---|---|---|
| Current rule | 0.82 / 0.93 / 0.44 | 0.80 / 1.00 / 0.53 | 0.51 / 0.95 / 0.24 | 20/32 | 5/5 | 16/17 | 16/16 | 117 |
| Chosen | 0.90 / 0.93 / 0.49 | 0.92 / 1.00 / 0.59 | 0.74 / 0.91 / 0.50 | 7/32 | 4/5 | 16/17 | 16/16 | 15 |
| Chosen with floor ln N + 2 | 0.90 / 0.93 / 0.49 | 1.00 / 1.00 / 0.62 | 0.91 / 0.91 / 0.59 | 2/32 | 4/5 | 16/17 | 12/16 | 8 |


So the list stays and the floor sits on top of it. For Dutch chatter (5 prompts in the
new split) the current rule leaked 1, the chosen rule 0: Dutch function words such as
`de` and `naar` are common in this index and carry little IDF mass.

### End to end (built CLI through `hooks/lotl_recall_hook.sh`, scratch copy, 161 prompts)

"Before" is the same build with `LOTL_MEMORY_RELEVANCE_MIN_CORPUS=1000000000`, which
switches the floor off and is the 2026-11-10 rule.

| Branch | split | before P / R / empty, leaks | after P / R / empty, leaks |
|---|---|---|---|
| memory | old dev | 0.97 / 0.97 / 0.51, 1 | 0.97 / 0.97 / 0.51, 1 |
| memory | old held-out | 1.00 / 1.00 / 0.62, 0 | 1.00 / 1.00 / 0.62, 0 |
| memory | new | 0.58 / 0.95 / 0.31, 15 | 0.91 / 0.91 / 0.59, 2 |
| memory | two-word | 1.00 / 1.00 / 0.00, 0 | 1.00 / 1.00 / 0.00, 0 |
| OKF | old dev | 0.93 / 0.93 / 0.51, 1 | 0.93 / 0.93 / 0.51, 1 |
| OKF | old held-out | 1.00 / 1.00 / 0.62, 0 | 1.00 / 1.00 / 0.62, 0 |
| OKF | new | 0.58 / 0.95 / 0.31, 15 | 0.91 / 0.91 / 0.59, 2 |
| OKF | two-word | 1.00 / 1.00 / 0.00, 0 | 1.00 / 1.00 / 0.00, 0 |

Junk rows on the new splits went from 87 to 9 (memory branch). Hook wall time over 161
prompts, median: memory branch 151 ms before, 139 ms after; OKF branch 154 ms before,
157 ms after (load average about 6, so read as unchanged). The two live leaks through the
CLI: "claude code rebooted" now returns nothing at r = 0.6, 0.7 and 0.8; "claude
restarted" returns only 82188d67. Default recall (no `--min-relevance`) was checked
byte-identical against a copy of the tree with the 2026-11-10 gate, 40 outputs (memory
and OKF recall, FTS and ONNX, 10 prompts) run back to back.

### Still leaking, and limits

- Three-term chatter whose words co-occur in one long memory ("api key expired",
  "android app crashed"): the floor is met and coverage is 1.0. Adjacency or length
  normalisation might catch these; not attempted.
- "deploy to prod" has a genuine answer among 22 memories that all contain the phrase;
  no lexical rule can pick it, and the floor now drops all of them.
- An on-topic prompt whose key word never occurs in the index ("autostart" against
  "auto-starts") fails coverage, as before.
- A per-project index where every memory names the project gives that name almost no
  IDF, so "<project> <word>" behaves like a one-word prompt. That is consistent with the
  two-term minimum but is a change from before on such indexes with >= 100 memories.
- 161 labelled prompts on one index; the new splits were written by the same person who
  wrote the rule, and the two-word split was added after the first sweep (see above).
