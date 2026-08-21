# Setup

Two levels, and they are independent:

1. **Machine** — install once per machine. Wires the hooks and puts the agents,
   skills and the `lanes` CLI where Claude Code can find them.
2. **Repo** — opt in once per repo, with a config file. Nothing happens in a repo
   that has not opted in: no events, no commit guard, no warnings.

Everything is reversible (`./install.sh --uninstall`).

---

## Prerequisites

| | |
|---|---|
| Node | ≥ 18. `node --version` |
| git | any recent version |
| `gh` | only for `/architect`, which creates GitHub issues. `gh auth status` |
| macOS | only for desktop notifications. Everything else is cross-platform |

No npm install. The system has zero runtime dependencies.

---

## 1. Machine install

```bash
git clone <this repo> ~/dev/agent-system     # or wherever you keep it
cd ~/dev/agent-system
./install.sh

# put the CLI on your PATH — this repo's own bin/, no copies, no symlinks
echo 'export PATH="$HOME/dev/agent-system/bin:$PATH"' >> ~/.zshrc && exec zsh
```

`install.sh` does two things and nothing else:

- symlinks `agents/*` and `skills/*` into `~/.claude/`
- merges its hook entries into `~/.claude/settings.json`

The CLI is deliberately **not** installed anywhere. Pointing PATH at `bin/` means
`git pull` is the whole upgrade: no stale copy, no symlink to re-point if you move
the clone. `install.sh` prints the export line for you and says so if `bin/` is
already on your PATH.

The merge is safe. It backs the file up with a timestamp first, and it only
removes hook entries whose command points inside this repo — identified by real
path, not by name, so renaming the clone directory does not orphan anything. Your
own hooks, statusline, permissions and settings are untouched. Re-run it whenever
you pull; it is idempotent.

**Restart any open Claude Code session.** Hooks load at session start.

---

## 2. Repo adoption

From anywhere inside the repo:

```bash
lanes adopt
```

This writes `.claude/agent-system.json` with what it can detect — package
manager from the lockfile, the `lint` / `typecheck` / `test` / `build` commands
from your `package.json` scripts, and the worktrees directory if the repo
actually has sibling worktrees. It refuses to overwrite an existing config
without `--force`.

Then **edit the generated file**. `lanes adopt` cannot detect the one field that
decides whether any of this is worth running.

---

## 3. Configure

Full field reference: `config/agent-system.schema.json`; an annotated starting
point: `config/example.agent-system.json`. The fields that matter:

### `review.domainAxes` — the one that decides everything

This is the list of judgment axes the reviewer applies **on top of** architecture
and durable context. Leave it empty and you get a reviewer that finds only what
your linter already found — expensive and useless. `lanes doctor` warns when it
is empty, on purpose.

**The test for an axis: a linter could not check it.** If a rule can be
mechanised, put it in your lint config where it runs in milliseconds, not here
where it costs an Opus call.

**How to find yours:** read the last 10–20 review comments your team left on real
PRs. Discard everything about formatting and naming. What is left — the comments
that needed someone who knows this product — is your axis list, already written
by your own team.

```jsonc
// Useless — a linter's job, or too vague to act on
"domainAxes": [
  "Follow best practices",
  "Code should be readable",
  "No unused imports"
]

// Useful — specific, needs product knowledge, cannot be mechanised
"domainAxes": [
  "Money paths: anything touching price, tax or discount must keep the calculation in one place and record the inputs it used. A second copy of the formula is a defect even when it agrees today.",
  "Offline-first. Users are on flaky connections — flag anything that assumes a request succeeds, or that loses local state on a failed sync.",
  "Both themes. Dark mode is the common case for our users, not an afterthought; any visual change has to be checked in both."
]
```

Write them in your team's own words, as claims a reviewer can act on. Three or
four sharp axes beat a dozen vague ones — the reviewer applies every one to every
changed file, so each weak axis dilutes the rest.

### `commands`

The reviewer never runs these — `/review` runs them once, at the end, over the
post-fix tree. Any command you leave `null` is a gate that gets skipped, and
`/review` says so in its summary rather than pretending it passed.

### `worktreesDir` and `basePort`

Only for the `lanes ui` dashboard. Lane N is the Nth subdirectory of
`worktreesDir` in alphabetical order, shown as serving on `${basePort}${N}`.
`basePort` is informational — nothing starts a server for you.

Alphabetical because the lane number must stay stable: git's own worktree
ordering shifts when you remove and re-add one.

**If your repo does not use worktrees, omit both.** Lanes are disabled, the
dashboard falls back to whatever sessions appear in the log, and every other part
of the system works normally.

`lanes` manages these worktrees for you — see **Managing lanes** below.

### Dev services

Each lane can run the project's services. Every project declares its own,
because no two stacks start the same way and one repo often has several:

```json
"dev": {
  "services": [
    { "name": "web", "command": "pnpm dev --port {port}", "portBase": 300,
      "url": "http://localhost:{port}" },
    { "name": "api", "cwd": "services/api", "portBase": 400,
      "command": "uv run uvicorn app.main:app --port {port} --reload" }
  ]
}
```

- **`command`** runs through a shell. Placeholders: `{port}`, `{lane}`,
  `{worktree}`, `{name}`.
- **`cwd`** is relative to the worktree root — set it for monorepo services.
- **`portBase`** is that service's own port series: lane N gets
  `${portBase}${N}`, so `web` on lane 2 is `3002` and `api` is `4002`. Separate
  bases keep services from colliding.
- Omit `dev` entirely and `lanes dev` simply tells you nothing is declared.
  Everything else works.

Services are started detached as process-group leaders, so `lanes stop` kills the
whole tree — no orphaned children when the wrapper script exits. Pids and logs
live in `~/.claude/lanes/`, keyed by **worktree name**, not lane number: lane
numbers shift when you add or remove a lane, and bookkeeping must not follow.

### Lane colours (per machine, not per project)

```bash
lanes color            # show the current palette
lanes color 2 832561   # set lane 2
```

Stored in `~/.claude/lanes/colors` as `N=hex`, one per line. **Deliberately not
in the committed config:** lane numbers come from your own worktree names, so
lane 3 is a different branch on a different machine and a shared palette indexed
by it would be meaningless.

If you already keep worktree colours in another tool's file, the format is the
same on purpose — symlink it and the two stay in sync with no coupling:

```bash
ln -s ~/.config/some-tool/colors ~/.claude/lanes/colors
```

### `branch.pattern`

How the issue number is extracted from a branch name. The first all-digits
capture group wins. Default expects `feat/123-slug`. If your team uses
`SPA-123-slug`, set `"pattern": "^[A-Z]+-(\\d+)-"`. `lanes doctor` tells you
whether your current branch actually matches.

### `review.commitGuard`

`true` (default) blocks `git commit` when the diff has not been through
`/review`. It does not just fail: it hands the agent a reason, the agent asks you
whether to review first or commit anyway, and "anyway" arms a one-shot bypass.

Set it to `false` if you do not want that. **The system remains useful without
it** — `/review` still works when you invoke it.

### `architect.issueProvider`

`"github"` needs `gh` authenticated. Set `"none"` if you do not use GitHub
issues; `/architect` then ends by handing you the spec instead of creating an
issue, and you file it wherever you actually track work.

### `DECISIONS.md` (optional, per repo)

If the repo root has a `DECISIONS.md`, `/review` and `/architect` will propose
entries for decisions a future session would plausibly reverse, and the reviewer
flags diffs that contradict a live entry. **If the file does not exist, they skip
it silently** and never create one uninvited. To opt in, create the file with a
one-line header; see this repo's own `DECISIONS.md` and `CLAUDE.md` for the
format and the policy.

### Editor validation (optional)

To get autocomplete and validation on the config, point `$schema` at this repo's
absolute path — a relative path will not resolve from your repo's `.claude/`:

```json
{ "$schema": "/Users/you/dev/agent-system/config/agent-system.schema.json" }
```

---

## 4. Verify

```bash
lanes doctor
```

It checks the machine install, the repo config and the current worktree, and
distinguishes problems (must fix) from warnings (usable, but you are getting less
than you could). Run it from inside the repo you just adopted — some checks are
worktree-specific.

Then, in a spare terminal:

```bash
lanes ui
```

Empty until a session produces events. Start a Claude Code session in an adopted
repo and it appears.

---

## 5. Managing lanes

```bash
lanes list                          # worktrees, branches, dirty state, services
lanes new app-5 --branch feat/1-x   # create a lane
lanes rm app-5                      # remove one; refuses to lose work
lanes switch 2 feat/42-thing --create
lanes each 'git fetch && git merge origin/main'   # across every lane
lanes dev 2      # start lane 2's services      (selector: 1 · 1,3 · 2-4 · . · all)
lanes stop       # stop everything
lanes logs 2 web -f
```

**Lanes are long-lived infrastructure.** You create them once and cycle branches
through them; `new` and `rm` are setup operations, not per-task ones. Per task,
`/architect` picks a free lane for you, or you use `lanes switch`.

**Creating a lane can renumber the others.** The number is the alphabetical
position, so a name that sorts early shifts everything after it — and the number
drives the colour and the port. `lanes new` prints exactly which lanes would move
before doing it, and suggests a name that sorts last. If you renumber while
services are running, `lanes list` marks them `!`: they are still on the port
they bound to, not the one their new lane implies. Restart them.

**`lanes rm` keeps the branch.** `git worktree remove` never deletes it, so
reusing the name later fails on "branch already exists". The command tells you
the exact `git branch -d` to run.

**A lane is "free"** when nothing would be lost by taking it over: clean tree,
and either on the base branch or with no commits the base does not already have.
`lanes free` lists them and exits 1 when there are none — that is what
`/architect` checks before placing a branch.

## 6. Daily flow

```
/architect         design first, adversarially → GitHub issue + linked branch
                   ↓  you decide when to move
                   implement, in the same session
                   ↓  you decide when to move
/review            review, apply fixes, write tests, run the gates
git commit         guarded: blocked unless /review passed on this exact diff
```

`/architect` is for non-trivial work only. It will tell you to skip it for typo
fixes, dependency bumps and anything you have already decided — ceremony on a
trivial task is the drag this system exists to avoid.

`/review` is worth running on every commit, and it works on code you wrote
without `/architect`.

**Commit small.** The reviewer is a commit-time gate, so diff size is review
quality: at ~200 changed lines the findings get applied, at 800 they get ignored.
The guard warns you past `review.largeDiffThreshold`.

---

## 7. Uninstall

```bash
./install.sh --uninstall
```

Removes the agent and skill symlinks and its hook entries (keeping your own), then
tells you what it deliberately left behind because it is yours: your event log at
`~/.claude/lanes/`, the PATH entry in your shell profile, and every
`.claude/agent-system.json` in your repos.

---

## Troubleshooting

**`lanes: command not found`** — this repo's `bin/` is not on your PATH. Re-run
`./install.sh`; it prints the exact export line for your clone location. Check
with `echo $PATH | tr : '\n' | grep agent-system`.

**Nothing appears in `lanes ui`** — most often the session predates the install.
Restart it. Then `lanes doctor`: if "hooks wired" fails, re-run `./install.sh`;
if "opted in" fails, you are not inside an adopted repo.

**The commit guard never fires** — check `review.commitGuard` is not `false`, and
that you are in a repo with a config. It is silent by design everywhere else.

**The guard fires again right after `/review`** — expected if anything edited the
tree afterwards. The marker is a hash of the diff, so approval cannot outlive the
code it approved.

**`/review` reports "nothing to review" with obvious changes** — check
`review.excludePattern`. A pattern that is too broad silently swallows your diff;
the skill prints what it excluded, so read that line.

**Lane numbers are not what you expect** — they are the 1-based alphabetical
position of each subdirectory of `worktreesDir`, so a worktree whose name sorts
differently than you assumed lands elsewhere. `lanes doctor` prints the lane it
resolved for the worktree you are standing in.
