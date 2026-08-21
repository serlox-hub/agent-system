---
name: gate
description: Reviews the uncommitted changes end to end — code review with clean context, auto-applies mechanical fixes, asks only about judgment calls, writes unit tests for what changed, then runs lint --fix and typecheck. Marks the diff as reviewed so the commit guard lets it through. Run this before every commit.
---

# Review

The single entry point for reviewing local work. Two agents do the analysis;
this skill orchestrates, applies fixes, and marks the result.

- `code-reviewer` — read-only, clean context. **Always runs.**
- `test-writer` — writes test files only. Runs unless nothing testable changed.

## Step 0 — Project context

```bash
lanes stage review
```

Read `.claude/agent-system.json` from the repo root. If it is missing, tell the
user the project has not opted in, point them at
`config/example.agent-system.json` in the agent-system repo, and stop. Do not
invent commands — running the wrong test command is worse than running none.

Bind: `$LINT`, `$LINT_FIX`, `$TYPECHECK`, `$TEST`, `$EXCLUDE` (from
`review.excludePattern`).

## Phase 1 — Scope and review

Compute the changed-file set **once** and reuse it everywhere downstream:

```bash
CHANGED=$( { git diff --name-only HEAD --diff-filter=ACMR; \
             git ls-files --others --exclude-standard; } | sort -u)
# Filter ONLY when a pattern is configured. `grep -vE ""` matches every line, so
# an unset excludePattern would silently drop the entire diff and report
# "nothing to review" on a repo full of changes.
if [ -n "$EXCLUDE" ]; then
  CHANGED=$(printf '%s\n' "$CHANGED" | grep -vE "$EXCLUDE" || true)
fi
```

If files were excluded, print one line naming them — silent exclusion reads as
full coverage. If `$CHANGED` is empty, print `Nothing to review` and stop.

Spawn `code-reviewer` with:

```
branch: <current branch>
issue: <issue number from the branch, or none>
files: <$CHANGED>
```

Store the report as `$REPORT`.

## Phase 2 — Classify and ask

**Only interrupt the user for judgment calls.** Mechanical fixes apply
themselves; that trade is the whole point of this flow.

- `Fixability: mechanical` → auto-apply in Phase 3, no question. Record in
  `$AUTO_APPLIED`.
- `Fixability: judgment` **with** `Alternatives:` → one radio question
  (`multiSelect: false`), the agent's options plus `Skip`. Put the rationale in
  each option's `description`.
- `Fixability: judgment` **without** `Alternatives:` → batched into a checkbox
  question (`multiSelect: true`), up to 4 per question.

Before asking anything, print the auto-apply notice — in the future tense,
because nothing has been edited yet:

```
Will auto-apply N mechanical fix(es) after your selections: rc-1, rc-4
```

Omit the line when N is 0.

Option text must be enough to decide without opening a file:

```
label:       "<severity> [<Category>] <file:line> — <short summary> (rc-N)"
description: "<Problem>. Fix: <Fix>."
```

Pack up to 4 questions per `AskUserQuestion` call and make calls back to back
until the queue is empty. An empty checkbox submission means skip that batch.

Skip this phase entirely when there are no findings at all.

## Phase 3 — Apply

**Batch A — mechanical.** Apply each `mechanical` finding via `Read` + `Edit`.
On failure (file moved, ambiguous fix) do **not** prompt: record it in
`$AUTO_APPLY_FAILED` with the reason and surface it in the summary.

**Batch B — user selections.** Apply what the user picked, in the order they
picked it. For radio answers, the chosen alternative *is* the instruction — do
not ask a follow-up question. If a selection turns out ambiguous, that is a
defect in the agent's `Alternatives:` wording: note it in the summary and skip
it, but do not go back to the user.

No verification between batches. Everything is verified in Phase 5.

## Phase 4 — Tests

Spawn `test-writer` with the **post-fix** file list (recompute `$CHANGED`, same
exclusions).

Skip only when no source files changed — config-only or docs-only diffs. Run it
even when the user selected zero fixes: their own new code may need tests
regardless of the review.

Store as `$TEST_REPORT`.

## Phase 5 — Gates, at the end

Phases 3 and 4 modify the tree, so validating earlier would validate a state that
no longer exists. **This is the only place the gates run** — `code-reviewer` is
explicitly forbidden from running them, so there is no duplicate pass.

1. `$LINT_FIX` — autofix without asking.
2. `$TYPECHECK` — no autofix. Surface errors as warnings in the summary,
   **not blocking**. Churn after a refactor is normal and the user decides.
3. `$LINT` again — report residual warnings that `--fix` could not resolve.
4. `$TEST` — the full suite. Phase 4 only ran the tests it wrote; this is the
   run that catches what the change broke elsewhere. Report failures as warnings
   with the failing test names, not as a block: the user decides whether a
   failure is churn or a real regression.

Skip any step whose command is not configured, and say which you skipped —
a silently skipped gate reads as a passing gate.

## Phase 6 — Record the decision, if there is one

The reviewer reports `## Decision candidates`. This step exists because you are
the best-positioned step in the whole flow to catch these: clean context, the
whole diff already read, and you run before every commit.

**The test for each candidate: would a future session reading this code
plausibly change it back?** If the reasoning is evident from the code, drop it.
If it is a fact about how something works rather than a choice between options,
it belongs in the README, not here.

Most diffs produce zero entries. Say `No decision entry needed` and move on —
padding the log with obvious entries is what stops people reading it, and that
costs more than the missing entry would have.

For each surviving candidate, ask the user with `AskUserQuestion` (batch them
into one call): the proposed entry text as the option `description`, plus a
`Skip` option. Do not write an entry they did not approve.

On approval, prepend the entry to `DECISIONS.md`. **If the repo has no
`DECISIONS.md`, skip this phase entirely** rather than creating one uninvited.

Match the conventions already visible in that file. If it has none — the entries
are freeform — use this shape, which is what the format is for:

```
## D<next id> — <the choice, as a claim>
`core` · <YYYY-MM> · <file:line>[ · #<issue>]
<why, at most 2 lines>
Rejected: <the obvious alternative> — <one clause on why it loses>
```

Propose `core` entries only. A `product` decision — what the tool does to its
users, where a boundary sits — is made in conversation and barely shows in a
diff, so it is `/architect`'s to record, not yours.

The `Rejected:` clause is the part that earns the entry: the failure mode is not
forgetting why something was done, it is a future session "improving" the code by
doing the thing that was already ruled out.

## Phase 7 — Mark reviewed

**Order matters: this must be the last thing that touches the tree** — after
Phase 6's `DECISIONS.md` edit included. The marker is keyed to a fingerprint of
the diff, so any edit after it invalidates it and the commit guard will fire
again. That is correct behaviour, but confusing if you mark too early.

```bash
lanes reviewed
```

If typecheck failed or lint left residual warnings, still mark it — those are
informational by design, and refusing to mark would make the guard fire for a
reason the user already saw and accepted. Say clearly in the summary that you
marked it despite open warnings.

## Phase 8 — Summary

```
## Review summary — <branch> <#issue>

### Findings
N found (C critical, I important) → A auto-applied, S user-selected applied

### Auto-applied (no question asked)
- rc-N [Category] file:line — summary
Revert any of these with `git restore <file>`.

### Not applied
- rc-N — <reason: skipped by user | auto-apply failed: …>

### Tests
- Created/extended: <files> — N tests
- Untestable without source changes: <list>

### Gates
- lint --fix: A warning(s) fixed
- lint residual: <list or clean>
- typecheck: clean | E error(s) — <listed>
- test: clean | F failing — <names>
- skipped: <any gate with no configured command>

### Decisions
- Added D<n>: <one-line claim>   | or: none needed

### Commit
Diff marked as reviewed — the commit guard will let this through until the tree
changes again.
```

Prepend `⚠️ N item(s) were not auto-fixed — check before committing.` when
anything is unresolved.

## Rules

- **Never commit.** This skill only modifies the working tree. The user commits.
- **Never fix things the agents did not report.** Scope discipline is what makes
  the summary trustworthy.
- **Only judgment calls reach the user.** Everything else is applied or skipped.
- **Never write a `DECISIONS.md` entry the user did not approve**, and never
  create the file if the repo does not already have one.
- **`lanes reviewed` runs last**, after every edit including the `DECISIONS.md`
  entry, or the marker is stale on arrival.
