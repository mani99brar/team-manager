# Test fixtures

Copies of files from finished feature directories that were deleted with the portable-workflow slice 1
(PRD_PORTABLE_WORKFLOW). Tests read them instead of `features/`; do not launch them.

- `project-workflows/`: the Projects viewer feature (feature 2.0.0, policy 1.2.0 with lanes `ui` and `adapter`) and its task files.
- `worker-lanes/policy.json`: a policy 1.1.0 whose required check kinds derive from the roles.
- `panel/`: the multi-provider panel's captured transport fixtures (docs/PRD_MULTI_PROVIDER_PANEL.md 4.3; `workflow/test_panel.py`):
  `pi-mode-json.jsonl` is a real `pi -p --mode json` stream (header lines `#` record the argv, `pi --version`, the `env -i` set,
  the cwd and `@` argument, the context size and the brief variant; the echoed context is cut, everything else verbatim),
  `brief-noenum.md` the enum-removed brief of that one capture, and `claude-print-probe.json` a real `claude --print
  --json-schema` probe (object-root success, array-root failure, the read-above-cwd denial).
