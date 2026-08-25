# Setup

Two levels, independent: **machine** (once) and **repo** (once per repo, opt-in —
no config file means no events, no commit guard, nothing). Everything reversible.

## Cheatsheet

| Want to... | Run |
|---|---|
| Install on this machine | `./install.sh` |
| Put `lanes` on your PATH | `echo 'export PATH="$PWD/bin:$PATH"' >> ~/.zshrc && exec zsh` |
| Opt a repo in | `lanes adopt` (from inside the repo) |
| Set this machine's lanes directory | `lanes worktrees-dir <path>` |
| Set this machine's port prefix | `lanes base-port <n>` |
| Set this machine's port for one service | `lanes service-port <name> <n>` |
| Check everything is wired correctly | `lanes doctor` |
| Watch the live lane dashboard | `lanes status` |
| Uninstall | `./install.sh --uninstall` |

---

## Prerequisites

| | |
|---|---|
| Node | ≥ 18. `node --version` |
| git | any recent version |
| `gh` | only for `/architect` (creates GitHub issues). `gh auth status` |
| macOS | only for desktop notifications — everything else is cross-platform |

Zero runtime dependencies. No `npm install`.

---

## 1. Install on your machine

```bash
git clone <this repo> ~/dev/agent-system
cd ~/dev/agent-system
./install.sh
echo 'export PATH="$HOME/dev/agent-system/bin:$PATH"' >> ~/.zshrc && exec zsh
```

What `install.sh` does, and nothing else:
- symlinks `agents/*` and `skills/*` into `~/.claude/`
- merges its hook entries into `~/.claude/settings.json` (backs it up first, keeps your own hooks)

PATH points at this repo's own `bin/` — no copies — so `git pull` is the whole
upgrade. Re-run `./install.sh` after every pull; it's idempotent.

**Restart any open Claude Code session.** Hooks load at session start.

---

## 2. Adopt a repo

```bash
cd <your-repo>
lanes adopt
```

Writes `.claude/agent-system.json`, auto-detecting the package manager and the
`lint`/`typecheck`/`test`/`build` commands from `package.json`. Won't overwrite
an existing config without `--force`.

If a worktrees convention is detected, or you accept the prompt below, `adopt`
sets `worktreesDir` and `basePort` too — but never in the committed file.
They're per-machine by nature (two developers may want their lanes on
different disks, naming conventions, or port ranges), so they always go into
the gitignored `.claude/agent-system.local.json` at the repo root, via `lanes
worktrees-dir`/`base-port` under the hood. `adopt` also adds that filename to
`.gitignore` if the repo has one, and warns if it couldn't (no `.gitignore` at
all, for instance). A team can still hand-write `worktreesDir` or `basePort`
into the committed config to mandate a shared convention — the local file just
wins whenever it's present.

If no worktrees convention is detected and you're running this from a real
terminal, it offers to create a sibling `<project>-lanes` directory and use
that — answer `n` to keep lanes disabled. This prompt only fires when there's
a TTY to ask on: a non-interactive run (scripts, CI, an agent driving `lanes
adopt` through a tool without a terminal) always skips it and leaves
`worktreesDir` unset, same as before — set it later with `lanes worktrees-dir
<path>` in that case.

**Now open the generated file and fill it in.** It ships with `"$schema"` already
pointing at this install, so every field shows its own documentation on hover in
your editor — that's the full field reference, no separate doc page to keep in
sync. (Not using an editor with JSON-schema support? Read
[`config/agent-system.schema.json`](../config/agent-system.schema.json) directly,
or [`config/example.agent-system.json`](../config/example.agent-system.json) for
a filled-in reference.)

One field `lanes adopt` cannot guess for you: **`review.domainAxes`**. Leave it
empty and the reviewer only finds what your linter already finds. Its hover doc
explains how to write it (short version: read your team's last 10-20 real review
comments, keep the ones that needed product knowledge, write 3-4 of those as
axes).

---

## 3. Verify

```bash
lanes doctor
```

Checks the machine install, the repo config and the current worktree; tells
problems (must fix) apart from warnings (usable, but you're leaving value on the
table). Run it from inside the repo you just adopted.

---

## 4. Watch the dashboard

```bash
lanes status
```

In a spare terminal. Empty until a session in an adopted repo produces events.

---

## 5. Managing lanes

```bash
lanes status # live dashboard — leave it running in a terminal, see §4
lanes status --once                 # one-shot snapshot: branch, marks, state, context, running services
lanes adopt  # scaffold .claude/agent-system.json for this repo, see §2
lanes doctor # verify the install, the repo config and this worktree, see §3
lanes new                           # create the next lane, detached at origin/main
lanes switch 2 feat/42-thing --create
lanes rm                            # remove the top lane; refuses to lose work
lanes clear                         # remove every lane, top-down; refuses to lose work
lanes reset 2                       # detach a lane back to a clean base state, keep it
lanes free                          # lanes safe to take over (what /architect checks)
lanes each 'git fetch && git merge origin/main'   # across every lane
lanes dev 2      # start lane 2's services      (selector: 1 · 1,3 · 2-4 · . · all)
lanes stop       # stop everything
lanes logs 2 <serviceName> -f
lanes color 2 832561                # per-machine lane colour, not committed
lanes worktrees-dir ~/proj-lanes    # per-machine worktreesDir override, not committed
lanes base-port 400                 # per-machine basePort override, not committed
lanes service-port <serviceName> 450  # per-machine, per-service portBase override
```

Lanes are long-lived infrastructure — create once, cycle branches through them.
Each is named `lane<N>` (N = max existing + 1), so the number is baked into the
directory at creation time and never shifts when another lane is added or
removed. `lanes rm` only ever pops the top of the stack — no argument needed,
since that's the only lane a single `rm` can legally remove; an explicit
number/name is accepted only as a confirmation that it names that same top
lane, and `all` is refused outright. `lanes clear` is the separate command for
removing every lane, top-down, in one call — a different word on purpose, so
it can't be reached by a typo or muscle-memory on `rm`. Both keep the branch
and print the `git branch -d` to run if you actually want it gone, and both
refuse outright if a declared service is still running in a targeted lane.
`lanes reset` returns a lane to that same clean, branch-free state without
removing it. A lane is "free" (what `/architect` looks for) when nothing would
be lost by taking it over.

Each lane can run the project's own services — a React client and a Python API
in one repo are two entries in `dev.services`, with their own commands,
directories and port series. They start detached as process-group leaders so
`lanes stop` kills the whole tree, and their bookkeeping is keyed by worktree
name rather than lane number, which is the part that moves. A service's own
`portBase` wins over the top-level `basePort` when both are set — `lanes
base-port` moves the informational lane-port hint, `lanes service-port` moves
where a service actually binds.

Three commands you won't usually type by hand — the skills call them for you:
`lanes reviewed` marks the current diff clean (`/gate` does this), `lanes
allow-commit` is a one-shot bypass of the commit guard, and `lanes stage
<name>` emits a pipeline-stage event.

---

## 6. Uninstall

```bash
./install.sh --uninstall
```

Removes the symlinks and hook entries it added (your own hooks untouched). Left
in place, because it's yours: your event log at `~/.claude/lanes/`, the PATH
entry in your shell profile, every `.claude/agent-system.json` in your repos.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `lanes: command not found` | `bin/` not on PATH — re-run `./install.sh`, it prints the exact export line |
| Nothing in `lanes status` | Session predates the install — restart it. Then `lanes doctor` |
| Commit guard never fires | Check `review.commitGuard` isn't `false`, and that the repo has a config |
| Guard fires again right after `/gate` | Expected — the tree changed since. The marker is a hash of the diff |
| `/gate` says "nothing to review" | Check `review.excludePattern` isn't too broad — the skill prints what it excluded |
| Lane numbers look wrong | Each lane is `lane<N>` — the number comes straight from the directory name, not a computed position; `lanes doctor` warns about any directory under `worktreesDir` that doesn't match `lane<N>` |

---

## Other repo-level opt-ins (not config fields)

- **`DECISIONS.md`** — if present at the repo root, `/gate` and `/architect`
  propose entries for decisions a future session would plausibly reverse, and
  the reviewer flags diffs that contradict a live one. Absent, they skip it
  silently. See this repo's own `DECISIONS.md` + `CLAUDE.md` for the format.
- **Lane colours** — `lanes color` — live in `~/.claude/lanes/colors`
  (`N=hex`, one per machine), deliberately *not* in the committed config: lane
  numbers come from your own worktree names, so lane 3 is a different branch on
  a different machine.
- **`worktreesDir`, `basePort` and per-service `portBase` overrides** — `lanes
  worktrees-dir`, `lanes base-port` and `lanes service-port` — live in the same
  gitignored `.claude/agent-system.local.json` at the repo's main worktree
  root, shared by every lane of that repo. Each wins over its committed
  counterpart, same reasoning as lane colours: two developers may want their
  lanes, their port range, or one service's port, somewhere different from
  each other. Run any of the three with no argument to see the current value
  and whether it's the local override or the committed default.
