#!/bin/bash
# Same command as gap-1-4's VEA-002 Codex replay (replay-commands.txt), plus --ignore-user-config (no MCP servers).
X="$(cd "$(dirname "$0")" && pwd)"; S="$1"
R="$(dirname "$X")"
date -u +%FT%TZ > "$X/$S.started"
codex exec --ignore-user-config --sandbox read-only --skip-git-repo-check --ephemeral -C "$R/vea2/challenge-worktree" \
  -m gpt-6-astra -c model_reasoning_effort=high --output-schema "$X/challenge-output.schema.json" \
  -o "$X/$S.last.json" --json - < "$X/challenge-prompt.txt" > "$X/$S.events.jsonl" 2> "$X/$S.stderr.log"
echo "exit $?" > "$X/$S.exit"; date -u +%FT%TZ >> "$X/$S.exit"
