# CLAUDE.md — agent-system

## Read DECISIONS.md before changing existing behaviour

It records **why** this code is the way it is and **what was already rejected**.
If you are about to "clean up", "simplify" or "fix" something that looks odd,
check there first — most of what looks odd here is load-bearing, and the entry
names the constraint you are about to break.

No line-count budget — `.md` files are exempt outright, since decision logs need
the room prose takes. Entries are pruned when their code is gone or their
decision reversed, not against a line count, so it stays worth reading in full
each time.

## Adding and pruning entries

One test for whether something deserves an entry: **would a future session
reading this code plausibly change it back?** If the reasoning is evident from the
code, no entry. If it is a fact about how something works rather than a choice
between options, it goes in the README.

Most commits need no entry. Do not add one to look thorough — a padded log stops
being read, which costs more than the missing entry would.

**Delete entries whose code is gone or whose decision was reversed.** Git keeps
the history; this file keeps only what is still load-bearing. Prune when you touch
the code an entry describes — never drop a live entry to make room.

Scope definitions and entry format live in `DECISIONS.md`'s own header. The
proposal mechanics live in the skills that do the proposing:

- **`/gate` proposes `core` entries** — clean context, whole diff read.
- **`/architect` proposes `product` entries** — `/gate` cannot catch these,
  since a product decision is made in conversation and barely shows in a diff.

Both propose, you approve, they write. Never write an entry the user did not
approve.

## Auditing is a byproduct, not a process

No periodic review of `DECISIONS.md`, deliberately — scheduled audits of a docs
file are a ritual nobody runs twice. Instead, `code-reviewer` reads the file, so
when a diff **contradicts a live entry** it reports that as a finding: either the
code is wrong or the entry is stale, and both are worth knowing at that exact
moment.

## Repo conventions

- **Zero runtime dependencies.** Plain Node ESM plus two POSIX sh scripts. Do not
  add a package to solve something the standard library covers.
- **Hooks must never break a session.** Every hook path swallows its own errors
  and exits 0. Observability is not correctness: failing to log an event is always
  preferable to failing a user's turn.
- **Hooks must never write to stdout** unless deliberately returning a decision to
  the model. Stray stdout is fed back into the session and costs tokens.
- **Agent prompts are the product.** `agents/*.md` and `skills/*/SKILL.md` carry
  more weight than the code. Edit them with the same care, and keep the
  adversarial posture — an agreeable reviewer is a broken reviewer.
- **English** for everything committed: prompts, issues, specs, comments.
- **Code files aim for ~150 lines, as a soft guideline, not a hard gate.** Not
  retroactive — `bin/lanes.mjs`, `ui/dashboard.mjs` and others already exceed it,
  and `test/smoke.mjs` has its own single-file convention (`tests.locationRule`
  in `.claude/agent-system.json`) that overrides it entirely. Treat crossing it as
  a prompt to consider splitting a *new or newly-touched* file, nothing more.
  `.md` files are exempt outright — decision logs and specs need the room prose
  takes.
