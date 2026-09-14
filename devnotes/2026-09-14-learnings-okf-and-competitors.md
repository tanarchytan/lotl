# What to take from OKF v0.2, claude-mem, autoharness, headroom

2026-09-14. Companion to `2026-09-14-state-of-lotl.md`, which covers where lotl
stands. This one is narrower: specific things the four reference points do that
lotl should copy, skip, or has already got right.

Confidence tiers used below: **source-direct** (read from the spec, the repo, or
measured on this machine), **modeled** (derived), **estimated** (judgement).

---

## 1. OKF: we built against v0.1, the spec is now v0.2

Source-direct: `GoogleCloudPlatform/open-knowledge-format/SPEC.md`, 1006 lines,
declares version **0.2**. lotl's `src/okf/` was designed 2026-07-19 against v0.1
(`docs/superpowers/specs/2026-07-19-okf-progressive-disclosure-design.md`).

Conformance in v0.2 is deliberately permissive (§11). A bundle conforms if:

1. every non-reserved `.md` has a **parseable** YAML frontmatter block,
2. every block has a non-empty `type`,
3. reserved filenames (`index.md`, `log.md`) follow §8/§9.

Everything else is soft. Consumers MUST NOT reject on missing optional fields,
unknown types, unknown keys, broken links, or missing `index.md`.

### 1.1 Bug found and fixed: 37% of our exported bundle did not parse

Source-direct, measured today. Exported the live index with
`scripts/okf-export.mjs` (1402 concepts), then parsed every frontmatter block
with PyYAML:

| | before | after |
|---|---|---|
| concept files | 1402 | 1402 |
| frontmatter fails to parse | **522 (37.2%)** | **0** |
| missing required `type` | 0 | 0 |

Cause: `title:` and `description:` were written unquoted. They come from
arbitrary memory text, so any `:` or leading `[` breaks the block
(`ScannerError: mapping values are not allowed here`). Fixed by quoting every
scalar. Rule 1 of §11 is the one rule a producer cannot be sloppy about, and it
is the one we were failing.

Also fixed in the same pass: root `index.md` now declares `okf_version: "0.2"`
(§12 allows frontmatter only there), and `timestamp:` became
`generated: { by, at }` — v0.2 §13.1 supersedes the bare `timestamp` key.

### 1.2 Not adopted yet, ranked by value

**a. Trust family (§5.2, §5.3) — highest value.** `generated: {by, at}` records
who wrote a concept; `verified: [{by, at}]` records who confirmed it. Trust
tiers fall out: no `verified` = unverified, non-`human:` verifiers =
machine-confirmed, a `human:<id>` verifier = human-reviewed.

This maps onto a distinction lotl already has but never exposes: a memory the
user typed (`lotl memory store`) versus one the extractor inferred from a
transcript. Right now both look identical at recall time. Storing the actor and
surfacing the tier is the cheapest credibility signal available, and it is the
one an agent most needs when two memories conflict.

**b. Lifecycle `status` (§5.4): `draft | stable | deprecated`, absent = stable.**
`memory compact`'s low-confidence review queue is exactly `draft`. Superseded
memories that we keep for history are exactly `deprecated`. Two enum values we
are already computing and throwing away.

**c. `stale_after` (§5.5), an absolute instant, not a TTL.** Deliberate spec
design: staleness is a plain `now >= stale_after` comparison with no reference
to read time. Complements Weibull decay rather than competing — decay models
*attention*, `stale_after` models *known expiry* ("this cert rotates in March").

**d. `sources` (§5.1) supersedes the body `# Citations` list (§13.1),** with
per-source credibility signals (`author`, `usage_count`, `last_modified`) and a
`usage_window` sibling. lotl's KG has the provenance; nothing projects it.

**e. `log.md` (§9), a reserved per-directory update log.** `memory_history`
already holds the data. Projecting it is a rendering job, not a schema job.

**f. Attested Computation (§10), a new concept type** whose body carries the
sanctioned computation and whose frontmatter names `runtime`/`executor`/
`attester`. Not relevant to lotl today. Worth knowing it exists before someone
asks for "verified metrics".

### 1.3 Also worth knowing: an OKF toolchain now exists

Source-direct, `gh search repos`: `scaccogatto/okf-skills` (386*, authoring +
validation + a GitHub Action), `openknowledge-sh/openknowledge` (CLI for
bundles), `zosmaai/pi-llm-wiki` (577*, "Native OKF v0.2"), `0dust/OKFy`,
`OWOX/models`, `linyiru/awesome-okf`. When we were designing this in July, OKF
was a format with no ecosystem. It now has validators, which is precisely why
1.1 matters: a non-parsing bundle is now something a third party will notice.

---

## 2. claude-mem (93.8k stars): episodic memory, sold as a product

**Take: the three-step retrieval loop.** `search` returns a compact index
(~50-100 tok/result), `timeline` gives chronological context *around* a hit,
`get_observations` pulls full records (~500-1000 tok each). We have step 1
(`okf_recall`) and step 3 (`okf_get`). We do not have step 2, and we are the
only one of the four with a real temporal KG (`knowledge_timeline`,
`valid_from`/`valid_until`) sitting there unexposed in the OKF surface. This is
the cheapest differentiated feature on the list.

**Take: `<private>` tags that exclude content from storage.** We have no
redaction on capture at all. For a tool that auto-captures from transcripts,
that is a trust gap, not a feature gap.

**Take: typed observations** (`decision`, `bugfix`, `security_alert`,
`sensitive`) used as retrieval filters. We have categories (fact / entity /
decision / reflection / preference) but do not filter recall on them by default.

**Skip: the hosted tier.** Account provisioning via email magic link, a hosted
"observer", Cloudflare sync-hub, cloud sync to cmem.ai. That is the opposite of
lotl's positioning and the reason to keep ours.

**Note, not a take:** they publish no benchmarks. The only numbers in the README
are token-cost estimates and a "~10x savings" claim. 93.8k stars regardless —
distribution beat measurement, and that is the honest read of our position.

---

## 3. autoharness (4.4k stars): procedural memory, bounded

**Take: separate `load` / `view` / `patch` signals.** Their lifecycle manager
ranks skills by usage rate and deliberately keeps those three as distinct
signals. lotl has a single `access_count`, incremented on every recall — so a
memory that surfaced and was ignored scores identically to one that was acted
on. Everything downstream of `access_count` (decay, tiers, eviction) inherits
that noise. This is the single biggest quality lever on the list and it is
ours to fix in the recall path.

**Take: "archives, never deletes".** Moving a folder back restores a skill.
Compare our situation: 134 memories on this machine are permanently truncated
stubs because the write path discarded originals (fixed today, see
`fix(memory): archive original text before write-time OKF compaction`). Same
lesson, learned the expensive way.

**Take: the ledger.** A per-item append-only sidecar recording *why* an entry
was born or changed, with evidence, kept outside the item body. `memory_history`
stores old and new value but no reason — so we can replay what changed and never
why.

**Take: deterministic tool-call triggers over timers and daemons.** Reflection
every 50 tool calls, consolidation at 250, no resident process. lotl's dream
consolidation is cursor-checkpointed, which is close, but the gateway_start-only
decay trigger was exactly this class of bug — fixed today for MCP users, who
had *never* had a decay pass run (all 902 memories still `peripheral`; the pass
promoted 646).

**Take: surface rejections.** Their session-start index includes the prior run's
landed *and rejected* proposals, "so a rejected proposal is visible instead of
silent". Our compaction review queue is silent by comparison.

**Our edge over them, stated plainly:** their README calls its own thresholds
"deliberate placeholders pending empirical calibration" and its validation is
usage-based rather than held-out scoring. Our tunables were validated at n=500
on LongMemEval. That is the moat.

---

## 4. headroom (72k stars): context compression

**Take: reversible compression is the design pattern, not a nicety.** Their CCR
compresses, keeps originals cached locally, and exposes `headroom_retrieve` so
the model can pull them back. That is precisely the shape of today's fix
(`metadata.original` + `okf_get` serving it). Worth naming the property
explicitly in the docs: lotl's byte budget is reversible; the write path
archives before it shortens.

**Take: `min_input_words` — blocks below the threshold are returned
byte-identical.** Our budget has no such guard: `BODY_MAX = 500` with a
hard character cut fires on prose that does not compress, spending quality for
nothing. A "don't bother" floor is a few lines.

**Take: live-zone compression.** They compress only newly arrived bytes so the
frozen prefix stays byte-identical and the provider KV-cache survives. Directly
relevant to lotl's always-injected recall block: if that block is rewritten
every turn it invalidates the prefix. Append-only within a session is the fix.

**Take: the holdout.** `HEADROOM_OUTPUT_HOLDOUT=0.1` reserves 10% of
conversations as an unshaped control so the dashboard reports a *measured*
saving instead of an estimated one. Same trick applies to recall quality in
production, not just in the eval harness.

**Take: their honesty.** They disclaim their own TruthfulQA gain (+0.030 at
N=100) as inside the confidence interval. A README that argues against its own
best number is more persuasive than one that does not, and we have better
numbers to be honest about.

**Skip: the telemetry beacon on by default.** Anonymous, no prompts or paths,
disableable three ways — and still the wrong default for a local-first tool. The
underlying need (catching compression regressions on real workloads) is covered
by our offline eval harness.

**Worth noting:** `headroom wrap claude` installs **Serena** at user scope as
its code-navigation companion, and the README recommends Ponytail for leaner
output. The ecosystem has converged on the same tools this machine uses.

---

## 5. The layer map

Source-direct from the four READMEs. These are not competitors to each other:

| Layer | Tool | What it stores |
|---|---|---|
| Context compression | headroom | nothing durable; shrinks bytes in flight |
| Episodic memory | claude-mem | what happened in sessions |
| Procedural memory | autoharness | how to do a recurring task (skills) |
| Retrieval substrate | **lotl** | facts, entities, docs, temporal KG |

lotl is the only one of the four that is a *store with measured retrieval
quality*. Estimated, and the strategic read: the substrate position is more
defensible than the capture position, because capture is a hook script and
retrieval quality is a year of benchmarking. It also means claude-mem and
autoharness are potential consumers, not rivals — both need a store, and
neither publishes recall numbers for the one they have.

---

## 6. Recommended order

1. **OKF trust + lifecycle fields** (§5.2-5.4). Actor on write, `status` from
   the compaction queue. Small schema surface, immediate recall-time value.
2. **Split `access_count` into recalled vs used.** Everything downstream of it
   is currently reading noise.
3. **`okf_timeline`.** We already have the temporal KG; claude-mem shipped the
   idea without one.
4. **Redaction on capture.** Trust gap.
5. **Min-compressible floor on the byte budget.** Few lines.

Deferred: `sources`, `log.md`, Attested Computation, the holdout harness.

Not in this list because it is already on the release path: the plugin manifest
and the benchmark-first README (see `2026-09-14-state-of-lotl.md`).
