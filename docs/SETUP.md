# Setup

Two levels, independent: **machine** (once) and **repo** (once per repo, opt-in —
no config file means no events, no commit guard, nothing). Everything reversible.

## Cheatsheet

| Want to... | Run |
|---|---|
| Install on this machine | `./install.sh` |
| Put `lanes` on your PATH | `echo 'export PATH="$PWD/bin:$PATH"' >> ~/.zshrc && exec zsh` |
| Opt a repo in | `lanes adopt` (from inside the repo) |
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
`lint`/`typecheck`/`test`/`build` commands from `package.json`, plus the
worktrees directory if there is one. Won't overwrite an existing config without
`--force`.

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
/review            review, apply fixes, write tests, run the gates
git commit         guarded: blocked unless /review passed on this exact diff
```

`/architect` is for non-trivial work only — skip it for typos, dependency bumps,
anything already decided. `/review` is worth running on every commit.

**Commit small.** The reviewer is a commit-time gate, so diff size is review
quality: findings get applied at ~200 changed lines, ignored at 800. The guard
warns past `review.largeDiffThreshold`.

---

## 6. Managing lanes

```bash
lanes list                          # worktrees, branches, dirty state, services
lanes new app-5 --branch feat/1-x   # create a lane
lanes rm app-5                      # remove one; refuses to lose work
lanes switch 2 feat/42-thing --create
lanes each 'git fetch && git merge origin/main'   # across every lane
lanes dev 2      # start lane 2's services      (selector: 1 · 1,3 · 2-4 · . · all)
lanes stop       # stop everything
lanes logs 2 web -f
lanes color 2 832561                # per-machine lane colour, not committed
```

Lanes are long-lived infrastructure — create once, cycle branches through them.
Creating one can renumber the others (lane N = Nth subdirectory of
`worktreesDir`, alphabetically); `lanes new` prints exactly what would move
before doing it. `lanes rm` keeps the branch — it prints the `git branch -d` to
run if you actually want it gone. A lane is "free" (what `/architect` looks for)
when nothing would be lost by taking it over.

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
| Guard fires again right after `/review` | Expected — the tree changed since. The marker is a hash of the diff |
| `/review` says "nothing to review" | Check `review.excludePattern` isn't too broad — the skill prints what it excluded |
| Lane numbers look wrong | They're the alphabetical position of each `worktreesDir` subdirectory — `lanes doctor` prints the one it resolved for where you're standing |

---

## Other repo-level opt-ins (not config fields)

- **`DECISIONS.md`** — if present at the repo root, `/review` and `/architect`
  propose entries for decisions a future session would plausibly reverse, and
  the reviewer flags diffs that contradict a live one. Absent, they skip it
  silently. See this repo's own `DECISIONS.md` + `CLAUDE.md` for the format.
- **Lane colours** — `lanes color` — live in `~/.claude/lanes/colors`
  (`N=hex`, one per machine), deliberately *not* in the committed config: lane
  numbers come from your own worktree names, so lane 3 is a different branch on
  a different machine.
