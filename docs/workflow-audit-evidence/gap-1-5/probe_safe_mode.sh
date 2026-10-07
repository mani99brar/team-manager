#!/bin/sh
# Probe: does a session started with the workflow's flags (--safe-mode --strict-mcp-config --mcp-config {}) load the
# CLAUDE.md of its working directory? A canary word lives only in CLAUDE.md; tools are disabled so the model cannot
# read the file itself. Control 1: the same call without --safe-mode. Control 2: --safe-mode plus the file's text
# passed explicitly with --append-system-prompt (a candidate delivery path for the fix).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
P="$HERE/safe-mode-probe"
OUT="$HERE/probe-results.txt"
cd "$P" || exit 1
Q='Do not use any tools. If your context contains project instructions that define a canary word, reply with that canary word. Otherwise reply exactly NONE. Reply with one word only.'
{
  echo "claude version: $(claude --version 2>&1)"
  echo "cwd: $P"
  echo "CLAUDE.md:"; cat CLAUDE.md
  echo
  printf 'A. --safe-mode (workflow flags): '
  claude -p --no-session-persistence --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "" --model haiku "$Q" 2>&1 | tail -1
  printf 'B. control, no --safe-mode:      '
  claude -p --no-session-persistence --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "" --model haiku "$Q" 2>&1 | tail -1
  printf 'C. --safe-mode + --append-system-prompt "$(cat CLAUDE.md)": '
  claude -p --no-session-persistence --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "" --model haiku --append-system-prompt "$(cat CLAUDE.md)" "$Q" 2>&1 | tail -1
} > "$OUT"
cat "$OUT"
