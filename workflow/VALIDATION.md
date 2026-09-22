# Readiness validation

The complete pipeline is ready for a **supervised local run** with an operator-approved feature policy. No live feature graph or new Claude implementation workers were launched during this readiness pass.

## Executed checks

- `python -m unittest workflow.test_graph workflow.test_sessions workflow.test_interactive workflow.test_verification workflow.test_pipeline -v`: **40 passed** (historical: `workflow.test_graph` was removed with the worker-lanes slice; run `python -m unittest discover -s workflow -t .` today).
- `npm run test:contracts`: **5 passed**.
- `npm run test:unit`: **130 passed** (existing Markdown-manager regression tests).
- `npm run build`: **passed**; existing Vite bundle-size warning remains.
- `npm run lint`: **passed**.
- `pip check`: **no broken requirements**.
- `git diff --check`: **passed**.

Python checks used the isolated `/tmp/md-manager-workflow-venv` environment, whose resolved dependencies are pinned in `requirements.lock`.

## End-to-end evidence covered

The offline pipeline uses fake workers, but actual Git, Python unittest and headless Chromium:

1. Separate workers start at the same committed base and modify disjoint owned files.
2. Explicit handoff captures immutable snapshots without modifying source HEAD.
3. Required build, backend unit tests, Playwright assertions and screenshot attachments execute in fresh verification worktrees.
4. Combined candidate checks run again before review.
5. Review and approval are separate interrupts bound to exact candidate/bundle hashes.
6. Explicit approval fast-forwards only the temporary test repository; no push.
7. The generated HTML viewer is opened in Chromium; graph visibility and screenshot links are asserted and a full-page image is captured in the temporary fixture.
8. An injected backend check failure reruns only that failed verification attempt after reopening checkpoints. Worker starts remain one each and the successful UI check packet stays byte-for-byte unchanged.
9. Tampered evidence, stale review, missing screenshots/checks, zero-test runs, ownership violations and incorrect role mappings block.
10. Native stop behavior is separately tested with mocked CLI/registry responses: successful stops, repeated calls, completed-stop-intent recovery, nonzero exits and lingering live workers. Missing handoffs do not stop workers.

Unit-test fixtures and their temporary screenshots are cleaned up by the test runner; no synthetic packet is represented as a real agent review or live feature result. Earlier interactive-launch validation did use real native Claude terminals and Herdr attachments; those two demo sessions were stopped before this pass.

## Independent review

Pi reviewer run `7182030a-c0fa-466e-8e0c-39839dc999da` found:

- P1: incorrect role mapping could bypass browser/backend test categories.
- P2: production stop/recovery boundary lacked offline coverage.

Both were fixed and regression-tested. Focused follow-up run `6618fab6-31a9-4e44-8162-c78d8de8abd9` found no remaining issues in that fix scope and returned **Merge verdict: OK**. The reviewer inspected source/tests, not live sessions or command execution; executed-check evidence above is the parent's.

## First-feature launch preparation follow-up

The Projects-viewer feature now has committed UI/adapter tasks, a versioned verification policy, a one-command supervised launcher, a private atomic run-state export, a hard three-attempt verification limit, and an explicit first adapter-verification gate failure. Follow-up local validation covers 47 Python tests plus 10 contract tests, including dry-run/no-consent/duplicate-launch guards and the configured failure drill across checkpoint reopening. No real workers were launched by these tests. The stable repository `.venv` is installed from the dependency lock on this VPS; it is ignored by Git.

The new `run-state.json` producer seam is documented in `features/project-workflows/README.md`. UI worker checks can use explicit API fixtures; combined-candidate checks are assigned to exercise the real adapter. The implementation of the Projects viewer itself is the work to be performed by that future run, not something this preparation claims to have shipped.

## Automatic feature-branch mode follow-up

Automatic mode is implemented directly in the existing LangGraph runtime, not Pi subagent tooling. Local validation now passes **59 Python tests**, 10 contract tests and lint. Synthetic reviewer executables exercise the real read-only reviewer transport, exact-bundle binding, reviewer rejection, and duplicate-launch prevention. An end-to-end test uses three actual Python controller processes against the same SQLite checkpoint, real Git/unit/Chromium checks, an injected adapter gate failure, UI reuse and adapter attempt 2; the original source branch remains unchanged. Only the test feature branch advances.

No real Claude workers or reviewer were launched for this validation. Actual live `--bg` permission-bypass behavior and model completion-protocol compliance still require the first owner-started live run. Worktrees are not security sandboxes. Automatic verification retries do not repair immutable source, and process deadlines require the controller to remain alive. No merge to main or push was performed for this implementation.

## Deliberate operator boundaries

- Select the feature, ownership and actual acceptance tests before preparing a run; the example policy is illustrative.
- Tests and setup commands are trusted code, not sandboxed workloads.
- Native terminal edits must stop before frozen verification.
- Independent review is supplied by Pi/a human as an explicit artifact; the graph never invents approval.
- Ambiguous native sessions, partial candidate allocations, source drift and exhausted usage stop for operator action, not silent relaunch/provider switching.
- `report.html` is a local snapshot viewer; controls remain authenticated-by-local-operator CLI actions, not a remote web service.
- Run/worktree cleanup and pushing remain separate, explicit actions.
