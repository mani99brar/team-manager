# Decisions: run-controls

From the grill session of 2026-10-10 with the operator.

## Operator decisions

- [O1] Grill 2026-10-10: the operator delegated every open question to the PRD's recommended defaults (`docs/PRD_RUN_CONTROLS.md` section 11, G1 to G8), recorded below as [G1] to [G8]; the delegation covers those eight items only. Operator: "Take all PRD defaults (Recommended)" (asked: "Build the run-controls UI now as a workflow run. How should its decisions be settled?"; operator's request: "We need to build the UI now").

## Grill defaults

- [G1] PRD G1 (a): one run, `server` and `viewer` lanes in parallel; the viewer lane mirrors Appendix A's types and mocks the routes in the worker phase; the candidate's real-backend browser check proves the two agree.
- [G2] PRD G2 (a): long commands (`restart`, `resume`, `accept_challenge`, `release_hold`, `repair_session`) run as transient user units (`systemd-run --user`), survive viewer restarts, and show their log on the page.
- [G3] PRD G3 (a): pairing is the token file plus Origin/Host checks (PRD 5.2).
- [G4] PRD G4 (a): the first cut has all twelve controls of PRD section 4.
- [G5] PRD G5 (a): no later controls now; `freeze` (manual runs), `note`, `tryout` and a follow-up `launch` are recorded as follow-ups.
- [G6] PRD G6 (a): "replay" means continue or run again: `restart`/`resume` continue; running again is a follow-up run, out of scope (PRD section 9).
- [G7] PRD G7 (a): `"critical": true` and `"tryout": true` in `feature.json` (the feature runs controller commands from a browser; an automatic run stops after review for the operator's `approve`, and the operator tries it before integrating).
- [G8] PRD G8 (a): allowed hosts are loopback on the web port only; the Mac tunnel forwards to the same port, so its Origin `http://localhost:5173` passes.

## Changes after launch

None yet.

## Deferred

- `freeze`, `note`, `tryout` and follow-up `launch` controls [G5].
- Running a run again as a new follow-up run from the page [G6].
- Named hosts beyond loopback [G8].
