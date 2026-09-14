# Testing conventions — `test/smoke.mjs`

Read this before adding or changing anything in the suite. The file is
thousands of lines long — past Claude Code's Read cap — so treat it as
something you navigate with the recipes below, never read whole.

## Imports

Static `import`s at the top of the file are `node:` builtins only. Every repo
module (`lib/*.mjs`, `ui/*.mjs`) is loaded later, through `await import(...)`,
after the suite points `process.env.HOME` at a throwaway temp directory.

`LANES_DIR` (`lib/context.mjs`) and `SESSIONS_DIR` (`lib/live-status.mjs`) are
both resolved from `os.homedir()` at module load time. A static `import` of
either module — or of anything that transitively imports them — would resolve
against the real home directory before the sandbox is in place, and the suite
would read and write the developer's real `~/.claude/lanes`.

## Order

`test(name, fn)` registers a test; it does not run it. The run loop at the end
of the file executes every registered test in registration order, once, top to
bottom.

Some tests rely on state a previous test left behind (a fixture directory, an
event log, a lane numbering sequence) rather than building their own from
scratch. Before adding a test:

- Place it next to the tests that already cover the function or area it
  touches, not at the end of the file.
- Read the stated preconditions of its neighbours — a test inserted in the
  wrong spot can silently fail because state it expects was never built, or
  disturb state a later test also expects untouched.
- Never register a test after the run loop — it will never execute, and
  nothing will tell you that it didn't.

## Tests are synchronous

The run loop calls `fn()` without awaiting. A test that returns a thenable
(an `async` function, or anything else returning a promise) is rejected as
unsupported and reported as a failure, instead of silently passing before its
assertions have actually run. Write assertions synchronously; if the code under test is genuinely async,
exercise it through a child process with `execFileSync` — as the hook and CLI
tests do — and assert on its output or its side effects; the harness cannot
await anything for you.

## Isolation

- A test that removes or rewrites lanes builds its own fixture — via
  `makeLanesFixture` or `makeCliLanesFixture` — with a name unique to that
  test: the underlying `mkdirSync` is not recursive, so reusing a name throws
  `EEXIST` instead of quietly sharing state with another test.
- A test that touches the live-status directory cleans up what it wrote
  there.
- The event log is shared across the whole suite run — filter what you read
  from it by project and worktree, rather than assuming it's empty or scoped
  to your test.
- Any global process state a test changes — an environment variable a spawned
  child process would also inherit, `process.stdout.columns`, or `fs` after
  patching it with `syncBuiltinESMExports()` — must be restored in a
  `finally`, so a failing assertion doesn't leak state into every test that
  runs after it.

## Finding things

Never read the file whole. Instead:

```bash
grep -n '^// ──' test/smoke.mjs               # section map
grep -nE '^(const|function) ' test/smoke.mjs  # top-level helpers
grep -n '<name>' test/smoke.mjs               # the function or test you're after
```

Then read slices of at most 150 lines around what the grep found — the
section map is usually enough on its own to know which slice to ask for.

## Running

```bash
node test/smoke.mjs   # and npm test — both quiet by default
VERBOSE=1 npm test    # one ` ok  <name>` line per passing test
```

Quiet mode prints only failures (`FAIL <name>` plus the full, untruncated
assertion message) and the final summary line. If a run hangs, re-run with
`VERBOSE=1` to see which test it stopped on — quiet mode gives no per-test
progress while a test is blocked.

After adding tests, confirm they actually ran: take a normal, quiet run's
`<N> passed, <M> failed` summary and check that `N` went up by exactly the
number of tests you added, with the exit code unchanged (0 when everything
passes).

A check that doesn't need a before/after baseline: `grep -c "^test(" test/smoke.mjs`
counts every registration, and must equal `passed + failed` — if it doesn't, a
test was registered after the run loop and never ran.
