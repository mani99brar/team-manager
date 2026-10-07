#!/bin/sh
# Re-run of probe A with the deny rule placed before another flag (--disallowedTools is variadic and
# swallowed the positional prompt in the first attempt), and C: a pkill-shaped deny rule, tested with a
# harmless command of that prefix that matches no process ("pgrep" is NOT used; the command is "pkill -0 -x zzzz-none").
set -u
cd "$(dirname "$0")" || exit 1
Q='Run exactly this shell command with the Bash tool and nothing else: echo DENYPROBE-$((40+2)). Then reply with the output you got, or with the word REFUSED if the tool call was denied.'
show() { python3 - "$1" <<'PY'
import json,sys
for l in open(sys.argv[1]):
    try: r=json.loads(l)
    except: print('  raw:', l.strip()[:200]); continue
    m=r.get('message') or {}
    for c in (m.get('content') or []) if isinstance(m,dict) else []:
        if isinstance(c,dict) and c.get('type')=='tool_result': print('  tool_result:', str(c.get('content'))[:220], '| is_error', c.get('is_error'))
        if isinstance(c,dict) and c.get('type')=='tool_use': print('  tool_use:', json.dumps(c.get('input'))[:120])
    if r.get('type')=='result': print('  result:', str(r.get('result'))[:200])
PY
}
echo "claude version: $(claude --version 2>&1)"
echo "== A2. deny rule Bash(echo:*) under --safe-mode + bypassPermissions + --dangerously-skip-permissions"
claude -p --disallowedTools 'Bash(echo:*)' --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools Bash --permission-mode bypassPermissions --dangerously-skip-permissions --model haiku --no-session-persistence --output-format stream-json --verbose "$Q" < /dev/null > a2.jsonl 2>&1
show a2.jsonl
