#!/bin/bash
# Replay one design-challenge sample with the live flags of workflow/automatic.py print_command
# (b92ff7d, unchanged since 3236749), plus --model/--effort pinned to what the archived sessions recorded
# (claude-opus-5-5, effort high). Output: stream-json trace + stderr; no session persistence.
# usage: run_challenge.sh <case-dir> <sample-label>
set -u
C="$1"; S="$2"
R="$(cd "$(dirname "$0")" && pwd)"
SCHEMA="$(cat "$R/challenge-output.schema.json")"
SID="$(uuidgen | tr 'A-Z' 'a-z')"
mkdir -p "$C/out"
date -u +%FT%TZ > "$C/out/$S.started"
cd "$C/challenge-worktree" || exit 2
env -u HERDR_PANE_ID claude --print --output-format stream-json --verbose --session-id "$SID" \
  --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --tools "Read,Glob,Grep" --permission-mode dontAsk --permission-prompts none \
  --add-dir "$C/challenge-inputs" \
  --model claude-opus-5-5 --effort high --no-session-persistence \
  --json-schema "$SCHEMA" < "$C/prompt.txt" > "$C/out/$S.stream.jsonl" 2> "$C/out/$S.stderr.log"
echo "exit $?" > "$C/out/$S.exit"
date -u +%FT%TZ >> "$C/out/$S.exit"
# the worktree must be unchanged (as run_challenge checks)
git -C "$C/challenge-worktree" status --porcelain >> "$C/out/$S.exit"
