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
| Watch the live lane dashboard | `lanes ui` |
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
lanes ui
```

In a spare terminal. Empty until a session in an adopted repo produces events.

---

## 5. Daily flow

```
/architect         design first, adversarially → GitHub issue + linked branch
                   ↓  you decide when to move
                   implement, in the same session
                   ↓  you decide when to move
/gate              review, apply fixes, write tests, run the gates
git commit         guarded: blocked unless /gate passed on this exact diff
```

`/architect` is for non-trivial work only — skip it for typos, dependency bumps,
anything already decided. `/gate` is worth running on every commit.

**Commit small.** The reviewer is a commit-time gate, so diff size is review
quality: findings get applied at ~200 changed lines, ignored at 800. The guard
warns past `review.largeDiffThreshold`.

---

## 6. Managing lanes

```bash
lanes list                          # worktrees, branches, dirty state, services
lanes new                           # create the next lane, detached at origin/main
lanes switch 2 feat/42-thing --create
lanes rm 2                          # remove the top lane; refuses to lose work
lanes reset 2                       # detach a lane back to a clean base state, keep it
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
removed. `lanes rm` only pops the top of the stack (a contiguous run ending at
the highest lane number; anything else is refused) — it keeps the branch and
prints the `git branch -d` to run if you actually want it gone, and refuses
outright if a declared service is still running in that lane. `lanes reset`
returns a lane to that same clean, branch-free state without removing it. A
lane is "free" (what `/architect` looks for) when nothing would be lost by
taking it over.

---

## 7. Uninstall

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
| Nothing in `lanes ui` | Session predates the install — restart it. Then `lanes doctor` |
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
  each other.
