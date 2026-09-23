# Adapter worker: viewer clarity (capture created files as evidence; serve them)

Implement the `adapter` half of `docs/PRD_VIEWER_CLARITY.md`. Read its sections 1, 2 and 4.1 as the specification and the adapter rows of section 6 as the test list. Section 4.1 pins the result shape exactly; the ui lane is building its fixtures against that paragraph at the same time, so implement it as written and record any deviation as an open assumption in your completion summary. Do not read the ui lane's worktree.

## Ownership

Only edit `workflow/`, `contracts/`, `server/` and `features/project-workflows/`. The UI worker owns `src/projects/` and `tests/project-workflows/`; do not edit them. Do not edit `features/viewer-clarity/`, `docs/`, package manifests, `src/` or the root Playwright configuration. Do not commit or push.

## Deliverables

1. Capture (PRD 4.1) in `workflow/checks.py` `verify_revision`: in the `worker` phase only, after the verification worktree is confirmed clean at the snapshot commit and before `run_lane_commands`, capture every path in `changed` that exists as a regular file, is text (decodes as UTF-8, no NUL byte) and fits the caps, as an artifact of kind `file` with its repo-relative `path`; list every other path in `files_not_captured` with reason `binary`, `too_large`, `missing` or `budget`. Caps are named constants: 512 KiB per file, 8 MiB per packet. The candidate phase captures nothing and lists nothing.
2. Contract in `contracts/workflow/workerResult.schema.json`, unchanged `contract_version` `1.0.0`: `file` in the artifact kind enum; optional `path` on artifacts, required exactly when kind is `file`, repo-relative with no `..` segment and no leading `/`; optional `files_not_captured: [{path, reason}]` with the four reasons. Mirror it in `contracts/workflow/v1.ts` and export; update `contracts/workflow/README.md`, `contracts/projects/README.md`, `examples.ts` and `contract.test.ts` in both families. A result without the new fields stays valid.
3. `recheck_packet` verifies `file` artifacts against their retained bytes like every other artifact; a mismatch fails the packet.
4. `server/projects.ts` and `server/projects.test.ts`: the served worker result passes `file` artifacts with `path` and `files_not_captured` through unchanged; a result recorded without them still validates; the artifact route serves a captured file with a text content type.
5. Tests in `workflow/test_checks.py` or `workflow/test_verification.py` for PRD section 6 `capture-text-files`, `capture-before-checks` and `tampered-file-artifact`, and in `server/projects.test.ts` for `served-files`.
6. Docs: `workflow/RUNBOOK.md` and `workflow/CHEATSHEET.md` describe the captured files, the caps and the reasons; `features/project-workflows/README.md` notes the new evidence in the viewer.

## Verification

Run in this worktree before signalling completion: the workflow unit suite (`.venv/bin/python -m unittest discover -s workflow -t .` from the repository root), `npm run test:contracts`, `npm run test:unit` and `npm run build`. Report every check you ran with its result.
