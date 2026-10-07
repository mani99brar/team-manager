#!/bin/sh
# Probe: does a --disallowedTools deny rule hold under the workflow worker's flags
# (--safe-mode, bypassPermissions, --dangerously-skip-permissions, Bash enabled)?
# The command is a harmless echo; a denied call never prints the marker in a tool result.
set -u
cd "$(dirname "$0")" || exit 1
Q='Run exactly this shell command with the Bash tool and nothing else: echo DENYPROBE-$((40+2)). Then reply with the output you got, or with the word REFUSED if the tool call was denied.'
FLAGS='--safe-mode --strict-mcp-config --mcp-config {"mcpServers":{}} --tools Bash --permission-mode bypassPermissions --dangerously-skip-permissions --model haiku --no-session-persistence --output-format stream-json --verbose'
echo "claude version: $(claude --version 2>&1)"
echo "== A. deny rule Bash(echo:*)"
claude -p $FLAGS --disallowedTools 'Bash(echo:*)' "$Q" > a.jsonl 2>&1
python3 - a.jsonl <<'PY'
import json,sys
for l in open(sys.argv[1]):
    try: r=json.loads(l)
    except: continue
    m=r.get('message') or {}
    for c in (m.get('content') or []) if isinstance(m,dict) else []:
        if isinstance(c,dict) and c.get('type')=='tool_result': print('  tool_result:', str(c.get('content'))[:200], '| is_error', c.get('is_error'))
        if isinstance(c,dict) and c.get('type')=='tool_use': print('  tool_use:', json.dumps(c.get('input'))[:120])
    if r.get('type')=='result': print('  result:', str(r.get('result'))[:200])
PY
echo "== B. control, no deny rule"
claude -p $FLAGS "$Q" > b.jsonl 2>&1
python3 - b.jsonl <<'PY'
import json,sys
for l in open(sys.argv[1]):
    try: r=json.loads(l)
    except: continue
    m=r.get('message') or {}
    for c in (m.get('content') or []) if isinstance(m,dict) else []:
        if isinstance(c,dict) and c.get('type')=='tool_result': print('  tool_result:', str(c.get('content'))[:200], '| is_error', c.get('is_error'))
        if isinstance(c,dict) and c.get('type')=='tool_use': print('  tool_use:', json.dumps(c.get('input'))[:120])
    if r.get('type')=='result': print('  result:', str(r.get('result'))[:200])
PY
