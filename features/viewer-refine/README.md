# viewer-refine

The run page shows the workflow the controller now runs (repair sessions as graph nodes, review rounds as attempts with their delta base, lane pins), opens on an answer instead of a metadata strip, groups steps and activity, lands slice S7 (Assignment as the setup page, the review diff inline), ranks Runs home by need and closes the revamp's eight P2s. A refinement of the Calm look, made by UI lanes that work with the impeccable skill. Specification: `docs/PRD_VIEWER_REFINE.md` (Appendix A pins the export 1.10.0 and the viewer contract). Decisions: `decisions.md` (grill of 2026-10-08).

- `feature.json`: three lanes. `adapter` (export, `contracts/projects`, `server`) on `claude-sonnet-5-5` at medium; `pages` (the run page) and `shell` (Runs home, the shell) on the default worker pin. Reviewers `general` and `coverage`, no sidecar, `critical: false`, `tryout: true` (you try the integrated run before the merge).
- **Before launch** (in this order): merge `worker-skills` to main; raise this file to `"version": "2.8.0"` and add `"skills": ["impeccable"]` to the `pages` and `shell` workers (the key is refused on 2.7.0); write `PRODUCT.md` and `DESIGN.md` at the repository root (`/impeccable init`, `/impeccable document`) and commit them; run the skill's launcher once so its engine binary is in `~/.impeccable/bin/`.
- `policy.json`: owned paths per lane (each UI task lists the DOM the other lane owns), the checks, the browser scenarios.
- `adapter-task.md`, `pages-task.md`, `shell-task.md`: the lanes' tasks as outcome briefs.

Launch: `python -m workflow launch viewer-refine --repo <this repository> --dry-run`, then `--live --automatic --profile attended --fix-rounds 2 --by operator`, from `~/dev/md-manager`, not beside the three pilots.
