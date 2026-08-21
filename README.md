# agent-system

A small, project-agnostic layer that adds two things Claude Code does not give
you out of the box:

1. **An architect gate** — an adversarial design conversation that happens
   *before* any code is written, and ends in a GitHub issue and its linked
   branch.
2. **A lane dashboard** — a live view of every worktree lane: which agent is
   running, which lane is waiting for you, and for how long. Zero token cost.

Plus a generic reviewer and test-writer that read their rules from each
project's own config instead of hardcoding one repo's conventions.

Zero dependencies. Plain Node ESM and two shell scripts.

## The flow

```
/architect  ──►  adversarial dialogue  ──►  spec-challenger (clean context)
                                                    │
                                                    ▼
                                        GitHub issue #123 + feat/123-slug
                                                    │
                          ── you decide when to move ──
                                                    ▼
                              implement (you + the main session)
                                                    │
                          ── you decide when to move ──
                                                    ▼
/gate       ──►  code-reviewer  ──►  auto-apply mechanical / ask on judgment
                                 ──►  test-writer  ──►  lint --fix + typecheck
                                                    │
                                                    ▼
                                          git commit  ──►  commit-guard
```

The two `── you decide ──` bars are deliberate. A pipeline that runs all the way
through without you multiplies the cost of a bad first step by every stage after
it, and turns you from a pilot correcting course into the final approver of a
large diff — the role humans are worst at.

## Getting started

```bash
./install.sh                                  # once per machine
export PATH="$PWD/bin:$PATH"                  # add to ~/.zshrc to keep it
cd <your repo>
lanes adopt                                   # once per repo — detects what it can
$EDITOR .claude/agent-system.json
lanes doctor                                  # verify
```

**Full walkthrough: [`docs/SETUP.md`](docs/SETUP.md).** The generated config
ships with `$schema` wired in, so every field — starting with `review.domainAxes`,
the one that decides whether the reviewer is worth running at all — documents
itself on hover in your editor.

A repo participates only if it has `.claude/agent-system.json` at its root. No
file means no events, no commit guard, no warnings — the right default for every
repo you have not thought about yet.

## `lanes`

```
lanes list               Worktrees, branches, dirty state, running services
lanes new / rm / switch  Lane lifecycle; refuses to lose work
lanes free               Lanes safe to take over (what /architect checks)
lanes each <cmd>         Run a command in every lane
lanes dev / stop / logs  This project's services, per lane
lanes ui                 Live dashboard (leave it running in a terminal)
lanes status             One-shot snapshot
lanes adopt              Scaffold .claude/agent-system.json for this repo
lanes doctor             Verify the install, the repo config and this worktree
lanes reviewed           Mark the current diff reviewed (the /gate skill does this)
lanes allow-commit       One-shot bypass of the commit guard
lanes stage <name>       Emit a pipeline stage event (the skills do this)
```

Lane N is the Nth subdirectory of `worktreesDir` in alphabetical order.
Alphabetical because the number has to stay stable: git's own worktree ordering
shifts when you remove and re-add one, and a lane number that moves is worse than
no lane number. `lanes new` warns before creating a lane that would renumber the
others.

Each lane can run the project's own services — a React client and a Python API in
one repo are two entries in `dev.services`, with their own commands, directories
and port series. They start detached as process-group leaders so `lanes stop`
kills the whole tree, and their bookkeeping is keyed by worktree name rather than
lane number, which is the part that moves.

Colours come from a built-in palette. Set your own with `lanes color 2 832561` —
stored per machine in `~/.claude/lanes/colors`, deliberately **not** in the
committed config: lane numbers come from your own worktree names, so lane 3 is a
different branch on a different machine.

## The commit guard

`git commit` is blocked when the current diff has not been through `/gate`.
The hook cannot talk to you directly, so it denies the call and hands the agent
a reason; the agent then asks you whether to review first or commit anyway. If
you choose to commit anyway it runs `lanes allow-commit` and retries.

The review marker is a hash of the diff, so it cannot outlive the code it
approved: edit one line after reviewing and the guard fires again.

Turn it off per project with `"review": { "commitGuard": false }`.

## Events

Everything is appended to `~/.claude/lanes/events.jsonl` by hooks — the model
never sees any of it, so the dashboard costs zero tokens.

| event | meaning |
|---|---|
| `session_start` / `session_end` | a Claude Code session opened / closed in a lane |
| `busy` | you sent a message; the lane is working |
| `idle` | the agent finished its turn — **the lane is waiting for you** |
| `agent_start` / `agent_end` | a subagent was spawned / returned |
| `stage` | a pipeline stage was entered (`lanes stage …`) |
| `reviewed` | `/gate` marked the diff clean |
| `commit_blocked` / `commit_bypass` / `commit_reviewed` | commit guard outcomes |

`idle` is the one that earns the dashboard its keep: with four lanes, the thing
you cannot see is which one has been sitting waiting on you for twenty minutes.

Appends are single-line JSON under 4KB, so POSIX `O_APPEND` keeps concurrent
sessions from interleaving without any locking.

## Tests

```bash
npm test
```

23 assertions over a real throwaway git repo with real worktrees: issue
extraction, lane numbering, event folding and its bounds,
review-marker staleness, and every branch of the commit guard. No dependencies.

Run it before publishing a change to `lib/`, `hooks/` or `ui/` — the guard's
option parsing in particular is the kind of thing that breaks silently.

## Known limitations

Stated plainly, because finding these yourself later is worse:

- **The architect's boundary is prompt-enforced, not tool-enforced.** It runs in
  your main session (you need a real conversation, and a subagent cannot give
  you one), and the main session has write tools. The boundary is *no
  implementation in the repo* — it may read and quote code, specify exact type
  signatures, and spike outside the repo to check feasibility. If it starts
  handing you an implementation, tell it to stop: that is a prompt failure, not
  a safe design.
- **The commit guard runs on every Bash call.** A few ms for the shell prescreen;
  the Node path (~50ms) only runs when the command mentions `commit`. The
  prescreen over-approximates on purpose — see `DECISIONS.md` D14.
- **The event log keeps one rotated generation** (2 MiB each). It is a dashboard
  feed, not an audit trail; if you want long-term history, ship the JSONL
  somewhere else.
- **Notifications fire only for events that arrive while `lanes ui` is running.**
  History is replayed into the display but never notified.
- **Project-local agents and skills win over these.** A repo with its own
  `.claude/agents/` or `.claude/skills/` keeps using them, so adopting this
  system there does not change existing behaviour on its own — you get the hooks
  and the dashboard, not the agents. Worth knowing before wondering why `/gate`
  behaves differently in one repo.

## Layout

```
CLAUDE.md         repo rules; points every session at DECISIONS.md
DECISIONS.md      why the code is the way it is, and what was rejected
docs/SETUP.md     install + per-repo configuration walkthrough
agents/           spec-challenger, code-reviewer, test-writer  → ~/.claude/agents/
skills/           architect, gate                              → ~/.claude/skills/
hooks/            emit.mjs, commit-guard.{sh,mjs}              → wired in settings.json
lib/              context.mjs (project/lane/event), marks.mjs (review markers)
ui/               dashboard.mjs (the lane dashboard)
bin/              lanes (sh wrapper) + lanes.mjs — put this dir on your PATH
config/           schema + annotated example
test/             smoke.mjs — npm test
```
