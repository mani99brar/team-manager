# Ready-to-launch feature: worker lanes from configuration (slice A)

This directory is the committed assignment for the two workers implementing `docs/PRD_WORKER_LANES.md`. It is removed before the feature branch merges, like the earlier feature directories, because its contents live in the PRD.

```bash
.venv/bin/python -m workflow launch worker-lanes --live --automatic --worker-timeout-seconds 10800
```

Lanes: `adapter` (backend role) owns the controller, contracts, server and the migration of `features/project-workflows`; `ui` (frontend role) owns `src/projects` and `tests/project-workflows`. The contract change (projects 1.3.0) is made by the adapter lane from the shape written in the PRD, and the UI lane builds its fixtures from the same text; that shared description is the seam between them. No failure drill. The adapter lane's first check runs the whole workflow unit suite with this checkout's virtual environment interpreter, so the run must be launched from this machine.

Default run: `~/.local/state/md-manager-workflows/worker-lanes/worker-lanes-001`. Default branch: `feature/worker-lanes/worker-lanes-001`. Nothing pushes or merges main.
