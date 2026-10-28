# State of lotl — 2026-09-14

Assessment: where lotl is, where the field went, what to do next.
Confidence tiers: **[V]** = source-direct (git/npm/gh api/local test run), **[M]** = modeled, **[E]** = estimated.

---

## 1. Where lotl actually is

| Fact | Value | Tier |
|---|---|---|
| Branch | `dev` | V |
| Local HEAD | `9e9058c` (docs: OKF progressive disclosure) | V |
| Last local commit | 2026-07-21 (**8 weeks ago**) | V |
| Commits unpushed | **16** | V |
| `origin/dev` last pushed | 2026-06-11 (**3 months ago**) | V |
| npm `latest` | `1.0.7`, published 2026-06-10 | V |
| npm `alpha` | `1.2.0-alpha.1` | V |
| `tsc --noEmit` | clean | V |
| `npm test` | **912 pass / 40 files pass / 1 file + 16 tests skipped**, 265s | V |

**The code is healthy. The problem is that nobody can see it.**

Three months of the best work in the project's history is sitting on a local
branch. Unshipped, per `CHANGELOG.md [Unreleased]`:

- **OKF progressive disclosure** (`okf_index` / `okf_get` / `okf_recall`, caveman byte budget on write, `memory compact` migration)
- **`lotl memory serve`** — dependency-free local web UI, 127.0.0.1, bearer-token gate
- **`LOTL_ONNX=on`** umbrella toggle
- **Cross-harness hooks** — Codex TOML + `hooks/opencode-lotl-memory.mjs`
- **`hooks/lotl_recall_hook.sh`** — UserPromptSubmit recall
- **Per-project isolation** via `INDEX_PATH`
- Two real fixes: `getDefaultDbPath()` parent-dir creation, `memoryStoreBatch` no longer crashes on missing `memories_vec`

This is not a "needs more work" list. It is a "needs `git push`" list.

---

## 2. Where the field went

All figures via `gh api`, 2026-09-14. **[V]**

| Repo | Stars | Forks | Created | Last push | Lang | License |
|---|---|---|---|---|---|---|
| thedotmack/claude-mem | 93,819 | 8,252 | 2025-08-31 | 2026-09-13 | TypeScript | Apache-2.0 |
| headroomlabs-ai/headroom | 71,999 | 5,516 | 2026-01-07 | 2026-09-13 | Python | Apache-2.0 |
| tigerless-labs/autoharness | 4,447 | 302 | 2026-06-09 | 2026-09-04 | Python | MIT |
| tanarchytan/lotl | — | — | 2026-04 (rename) | 2026-06-11 | TypeScript | MIT |

### They are not all the same product

The instinct is to read 93k stars as "we lost". Wrong frame. Four different layers: **[M]**

| Layer | What it does | Who owns it |
|---|---|---|
| **Wire / compression** | Shrink bytes before they hit the model | headroom |
| **Episodic** | Capture what happened, replay it next session | claude-mem |
| **Procedural** | Turn repeated work into reusable skills | autoharness |
| **Retrieval substrate** | Hybrid search + temporal KG, measured quality | **lotl** |

claude-mem and lotl overlap at the recall surface but not underneath.
claude-mem is a capture-and-replay pipeline. lotl is a search engine that
happens to store memories. Different failure modes, different ceilings.

### Two things the field settled while we were away

**Progressive disclosure is table stakes.** Everyone converged on
index-first, fetch-on-demand rather than dumping context up front. lotl's OKF
implementation is *good* and is exactly this. It is also unpushed and
**default-off** (`LOTL_OKF=on`). We built the convergent design and shipped
none of it.

**One-line install is the distribution norm.** `/plugin marketplace add owner/repo`
and done. That is the whole install story for the competition.

---

## 3. The three real gaps

### Gap 1 — Distribution (biggest, cheapest to fix)

Current lotl install: `npm i -g` → `claude mcp add` → hand-wire hooks into
`settings.json` → set env vars. **[V]** That is four steps and a text editor
against a competitor's one line.

`.claude-plugin/marketplace.json` already exists (since 2026-04-18) and is
well-formed. But: **[V]**

- `"version": "1.0.0"` — stale against `package.json` 1.2.0-alpha.1
- declares `skills` + `mcpServers`, declares **no `hooks`**
- no `.claude-plugin/plugin.json` (only `marketplace.json` in that dir)

So the four hook scripts in `hooks/` (`lotl_save_hook.sh`,
`lotl_recall_hook.sh`, `lotl_precompact_hook.sh`,
`opencode-lotl-memory.mjs`) — the things that make memory *automatic* — are
not wired into the plugin at all. A user who installs the plugin gets the
MCP server and the skill, and still has to hand-configure the part that
matters.

The scaffolding is 80% built and 0% published.

### Gap 2 — OKF is default-off

Default-off means the flagship feature has an adoption rate of approximately
zero. **[M]** The reason for the gate (behavior change, byte budget on write)
was sound at build time. It has been correct and untested-in-the-wild for
three months.

### Gap 3 — No procedural axis

autoharness went 0 → 4,447 stars in three months on procedural memory alone. **[V]**
That is demand signal for "remember *how*, not just *what*". lotl has the
substrate (KG + retrieval) and none of the surface.

This is the only gap that is real product work rather than release hygiene.

---

## 4. What we actually have that they don't

**Published retrieval benchmarks.** lotl reports LongMemEval
(`_s_cleaned`, n=500) at **R@5 86.2% / MRR 0.888 / JudgeCorrect 73.8%** and
LoCoMo at **R@5 60.0% / MRR 0.467**. **[V, devnotes/todo.md]**

- claude-mem publishes no retrieval metrics **[V]**
- autoharness markets "no benchmark" as a feature **[V]**
- headroom publishes compression ratios, not recall **[V]**

Nobody else in this space can tell you whether their memory system actually
retrieves the right thing. We can, with a number, on two public datasets.

That is the moat. Not the SQLite choice, not the local ONNX, not the hybrid
search — those are implementation. The moat is **being the only one who
measured**.

Corollary: local-first is the position, not a limitation. Do not chase cloud
sync or a hosted tier. claude-mem already won that lane on distribution, and
entering it trades away the one thing that differentiates us.

---

## 5. Recommendation

One path, in order. Do not reorder — each step unblocks the next.

| # | Action | Cost | Unblocks |
|---|---|---|---|
| 1 | Push the 16 commits. Cut **1.1.0** to npm `latest`. | ~30 min **[E]** | Everything. Nothing below ships without this. |
| 2 | Complete the plugin manifest: add `.claude-plugin/plugin.json`, sync version, add `hooks` block wiring the four existing scripts. | ~half day **[E]** | One-line install. Closes the distribution gap. |
| 3 | Flip `LOTL_OKF` **on by default**. Gate the old path behind `=off`. | ~1 hr + a test pass **[E]** | Real-world validation of the convergent design. |
| 4 | README: lead with the benchmark table. | ~1 hr **[E]** | The only differentiated claim we have, currently buried. |
| 5 | *Then* decide on the procedural axis. | — | Not before 1-4. |

**Steps 1 through 4 are three months of value released in roughly one day of
work.** Step 5 is the only one that needs a design conversation.

Name the pace honestly: steps 1-4 are the boring release-hygiene phase, which
is exactly the kind of work that has been deferred to "later" for three
months. The engineering is done. What is left is the unglamorous part.

### What not to do

- **No cloud sync / hosted service.** Loses the moat, enters a lane already won.
- **No rewrite to chase claude-mem's surface.** Different layer, different product.
- **No new features before step 1.** Adding commit 17 to an unpushed branch is not progress.

---

## 6. Open question for the user

Step 5 (procedural memory) is a genuine product decision, not a release task.
Two readings:

- lotl stays a **substrate** — expose the KG well, let autoharness-likes build on top
- lotl grows a **skills surface** of its own

Recommendation: substrate. It is consistent with the benchmark moat and does
not put us in a footrace with a project that has a three-month head start on
that specific axis. But this one is worth disagreeing with.
