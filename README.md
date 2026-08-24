# agent-system

A small, project-agnostic layer that adds two things Claude Code does not give
you out of the box: an **architect gate** — an adversarial design conversation
before any code is written — and a **lane dashboard** — a zero-token live view
of every worktree lane, so you always know which one is waiting on you.

Plus a generic reviewer and test-writer that read their rules from each
project's own config instead of hardcoding one repo's conventions.

Zero dependencies. Plain Node ESM and two shell scripts.

## Install

```bash
./install.sh                                  # once per machine
export PATH="$PWD/bin:$PATH"                  # add to ~/.zshrc to keep it
cd <your repo>
lanes adopt                                   # once per repo — detects what it can
$EDITOR .claude/agent-system.json
lanes doctor                                  # verify
```

A repo participates only if it has `.claude/agent-system.json` at its root. No
file means no events, no commit guard, no warnings.

Full walkthrough (prerequisites, config fields, troubleshooting):
[`docs/SETUP.md`](docs/SETUP.md).

## Daily flow

```
┌─────────────┐
│ /architect  │   adversarial dialogue → spec-challenger (clean context)
└──────┬──────┘   → GitHub issue #123 + branch feat/123-slug
       │
       ·  you decide when to move
       │
┌──────▼──────┐
│  implement  │   you + the main session
└──────┬──────┘
       │
       ·  you decide when to move
       │
┌──────▼──────┐
│    /gate    │   code-reviewer → auto-apply mechanical, ask on judgment
│             │   test-writer   → writes tests, then lint --fix + typecheck
└──────┬──────┘
       │
┌──────▼──────┐
│ git commit  │   blocked unless /gate passed on this exact diff
└─────────────┘
```

The two `you decide when to move` gates are deliberate: a pipeline that runs
straight through multiplies the cost of a bad first step by every stage after
it, and makes you the final approver of a large diff instead of a pilot
correcting course.

`/architect` is for non-trivial work only — skip it for typos, dependency
bumps, anything already decided. `/gate` is worth running on every commit.
Commit small: review quality drops off past ~200 changed lines.

## `lanes` cheatsheet

```
lanes new              Create the next lane, detached at origin/main
lanes switch <n> <br>  Put a branch in a lane (--create to make it)
lanes rm               Remove the top lane; refuses to lose work
lanes dev <n>          Start a lane's services
lanes status           Live dashboard — leave it running in a terminal
lanes status --once    One-shot snapshot: worktrees, branches, dirty state, first service per lane
```

Full command reference (numbering, per-machine overrides, services, colours):
[`docs/SETUP.md`](docs/SETUP.md#5-managing-lanes).

## Learn more

| | |
|---|---|
| Install + per-repo config | [`docs/SETUP.md`](docs/SETUP.md) |
| Full `lanes` command reference | [`docs/SETUP.md`](docs/SETUP.md#5-managing-lanes) |
| Commit guard, events, known limitations, tests | [`docs/REFERENCE.md`](docs/REFERENCE.md) |
| Why the code is the way it is | [`DECISIONS.md`](DECISIONS.md) |

## Layout

```
CLAUDE.md          repo rules; points every session at DECISIONS.md
DECISIONS.md       why the code is the way it is, and what was rejected
docs/SETUP.md      install + per-repo configuration walkthrough
docs/REFERENCE.md  commit guard, events, known limitations, tests
agents/            spec-challenger, code-reviewer, test-writer  → ~/.claude/agents/
skills/            architect, gate                              → ~/.claude/skills/
hooks/             emit.mjs, commit-guard.{sh,mjs}              → wired in settings.json
lib/               context.mjs (project/lane/event), marks.mjs (review markers)
ui/                dashboard.mjs (the lane dashboard)
bin/               lanes (sh wrapper) + lanes.mjs — put this dir on your PATH
config/            schema + annotated example
test/              smoke.mjs — npm test
```
