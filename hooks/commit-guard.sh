#!/usr/bin/env sh
#
# Cheap prescreen in front of the commit guard.
#
# PreToolUse matchers key off the tool NAME, so this hook is invoked on every
# single Bash call. Paying ~50ms of Node startup on each one would be a real tax
# on a tool that runs constantly. A shell + grep prescreen costs a few ms.
#
# This is deliberately an OVER-approximation: it only asks whether the word
# "commit" appears at all, and lets Node decide precisely. Trying to be clever
# here is how `git -C . commit` slipped through an earlier version — the shell
# cannot parse git's option grammar, so it should not try. False positives cost
# one wasted Node start on a command that mentions "commit"; a false negative
# costs an unreviewed commit.
#
# stdin is the hook payload (JSON). We read it once and forward it verbatim.

IN=$(cat)

case "$IN" in
  *commit*) ;;
  *) exit 0 ;;
esac

DIR=$(dirname "$0")
printf '%s' "$IN" | node "$DIR/commit-guard.mjs"
