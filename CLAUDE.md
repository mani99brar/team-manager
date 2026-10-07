# Project conventions

- md-manager: a Vite/React viewer (`src/`, `server/`, `contracts/`) plus the Python workflow controller (`workflow/`, standard library only, Python 3.12 in `.venv`).
- Build and test: `npm run build`, `npm run lint`, `npm run test:unit`, `npm run test:contracts`; the workflow suite is `.venv/bin/python -m workflow.run_tests` (parallel unittest; see `workflow/run_tests.py`).
- Code style: match the surrounding module. Workflow modules open with a docstring that states the behaviour and cite the RUNBOOK section they implement; tests isolate every path under a temporary directory and never touch the real `~/.config/md-manager/`, `~/.claude` or systemd.
- Boundaries: never read or copy a secret (`~/.claude/channels/*/.env`, `*/notify.env`, `~/.config/pi/*.env`); never push; never edit files outside the lane's owned paths.
- Docs: `workflow/RUNBOOK.md` is the operator's reference and `workflow/README.md` the command table; a new command gets a row and a section.

## Workflow (operator notes; workers skip this section)

- Workflow sessions start with --safe-mode, which does not load this file: for a feature at feature.json 2.2.0 or later the controller pins what is above this heading, as the run's base commit holds it, into every worker, design challenge and reviewer prompt. No session gets this section.
- Runs are stored under `~/.local/state/md-manager-workflows/<feature>`.
- Critical paths: none.
