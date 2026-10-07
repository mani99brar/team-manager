#!/bin/bash
# Replay one native reviewer sample in print mode with the native reviewer's tools and permissions
# (workflow/interactive.py launch_reviewer: Read,Glob,Grep,Write; Edit allowed only on its completion file;
# --add-dir <run dir>; dontAsk; --safe-mode; no MCP), plus --model/--effort as the archived sessions recorded.
# usage: run_review.sh <case> <sample> <reviewer>
set -u
R="$(cd "$(dirname "$0")" && pwd)"
CASE="$1"; S="$2"; REV="$3"
D="$R/$CASE/$S"; RUN="$D/run"
COMPLETION="$RUN/review-$REV.completion.json"
SID="$(uuidgen | tr 'A-Z' 'a-z')"
date -u +%FT%TZ > "$D/started"
cd "$RUN/review-worktree" || exit 2
claude --print --output-format stream-json --verbose --session-id "$SID" \
  --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --tools "Read,Glob,Grep,Write" --allowedTools "Edit(/${COMPLETION})" \
  --add-dir "$RUN" --permission-mode dontAsk --permission-prompts none \
  --model claude-opus-5-5 --effort high --no-session-persistence \
  < "$D/prompt.txt" > "$D/stream.jsonl" 2> "$D/stderr.log"
echo "exit $?" > "$D/exit"
date -u +%FT%TZ >> "$D/exit"
git -C "$RUN/review-worktree" status --porcelain >> "$D/exit"
