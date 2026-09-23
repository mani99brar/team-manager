# Workflow audit: the automatic LangGraph controller, answered from the code

Audited at commit `13fd687` (branch `feature/workflow-audit/workflow-audit-001`) on 2026-09-23. Every `path:line`
below refers to that commit. "Tested" names the test class and method that asserts the behaviour; "untested" means no
test in `workflow/test_*.py` exercises it. Recorded runs under `~/.local/state/md-manager-workflows/` were read
read-only; where they show behaviour of an older controller version, the commit that changed it is named.

Vocabulary used throughout: *lane* is a worker lane from `plan.workers`; *receipt* is `<node>.interactive.json`;
*completion file* is `<node>.completion.json`; *status file* is `automatic-review.json` (combined, and the default
reviewer's own) or `automatic-review-<id>.json`; *the checkpoint* is the LangGraph `SqliteSaver` thread in
`pipeline.sqlite` keyed by `run_id` (`workflow/pipeline.py:719-721`).

## 1. Interrupted runs

**Answer.** A run interrupted while workers or native reviewers are running resumes with
`python -m workflow automatic "$RUN" --live` and loses nothing but wall-clock time; a run interrupted while the
trusted verifier, the cherry-pick or a print-transport review is running does not resume by itself, and the operator
must either retry one check explicitly or start a new run. Deadlines keep counting while the controller is away and
are evaluated before completion files on resume, so a late resume can end a run whose workers had finished in time.

### How it works

The supervisor `supervise` (`workflow/automatic.py:738-752`) runs `automatic-step` in a fresh process per graph step;
exit 75 means "checkpoint persisted, run again", any other non-zero exit ends the supervisor with
`Automatic controller blocked (exit N); inspect retained run`, and after 45 steps it stops with
`Automatic controller restart limit exhausted` (`:742-752`). A Ctrl-C in the supervisor becomes
`Supervisor interrupted. Native workers were NOT stopped and keep running; resume with: ...` (`:746-747,755-756`).
Each step is `drive` (`:776-838`): it reopens the checkpoint, refuses to continue if `state.next` still holds a
`launch_*` node (`:788-789`), waits on the `worker_handoff` interrupt with `wait_handoffs` (`:800-819`), classifies
errors with `advance_failed_checks` or `reviewer_stop_pending` (`:822-823`), and invokes the graph once (`:825`).
Every step boundary writes `report.html` and `run-state.json` (`:836`, `workflow/pipeline.py:724-728`).

Durable state is the checkpoint, the receipts, the completion and handoff files, `snapshots.json`, `attempts.json`,
`candidate.json`, `review-bundle.json`, the status files, `review.json`, `integration-intent.json` and the stop markers
`<node>.stop.json`. All are written with `save_json` (temporary file, fsync, rename, directory fsync;
`workflow/sessions.py:125-138`). The controller lock is an `flock` (`:141-152`), released by the kernel when the process
dies, so a crash never leaves a stale lock.

**Ctrl-C while workers are running.** `wait_handoffs` polls the native inventory every two seconds (`:113-141`). A
`KeyboardInterrupt` inside it is caught in `drive`, one `interrupted` event is written, the report is refreshed and the
interrupt propagates (`:803-808`); `stop_workers` is not called. On resume the interrupt `worker_handoff` is still
pending in the checkpoint, so `drive` re-enters `wait_handoffs`, which re-reads the receipts and completion files.
Nothing is lost: handoffs are derived from completion files, not from memory (`:134-140`). The in-memory `attention` set
(`:112`) is lost, so a worker in native state `blocked` is announced once more after resume. Tested:
`AutomaticGraphTests.test_interrupt_during_worker_wait_keeps_workers_and_resumes` (drive level, `stop_workers` not
called, resume completes without relaunch) and
`CompletionTests.test_supervisor_interrupt_reports_resume_without_stopping_workers` (supervisor level). Recorded:
`parallel-reviewers-001` events 15-16 and `worker-lanes-001` events 9-10 show exactly this resume.

**Controller crash (SIGKILL, OOM, power).** No event is written. Recovery is the same as above because nothing is held
in memory that the next step needs. Two crash windows matter:

- Between `save_json(<lane>.handoff.json)` (`:139`) and the graph resuming: the interrupt is still pending, so
  `wait_handoffs` runs again and rewrites the same handoffs from the same completion files. Idempotent by
  construction, untested for the crash itself.
- After the stop intents were written but before `snapshots.json`: `wait_handoffs` sees a `<lane>.stop.json` and
  skips polling, re-validating that every completion file still equals the saved handoff
  (`Handoff changed after stop intent`, `:106-111`); `stop_session` reuses the intent and never signals a second
  time (`workflow/pipeline.py:328-354`); `freeze` returns the saved `snapshots.json` when it exists (`:369-371`).
  Tested: `CompletionTests.test_stop_intent_recovery_uses_existing_validated_handoffs`,
  `PipelineTests.test_completed_stop_intent_is_reconciled_without_another_stop`,
  `PipelineTests.test_native_stop_success_and_partial_recovery`. The recorded run `worker-lanes-001` (events 6-8)
  shows the practical consequence: an inventory error stopped the controller, the stop itself failed, and the run
  resumed because no stop marker had been written.

**Interrupted while the trusted verifier is running.** The check's process group is killed
(`workflow/checks.py:36-38`) and the attempt directory `verification/<phase>/<node>/<attempt>/` is left without a
`packet.json`. On resume `verify_revision` refuses that directory with
`Interrupted check attempt exists; use an explicitly incremented attempt` (`:152-153`). `advance_failed_checks` cannot
classify it because it only retries attempts that have a non-passing packet (`workflow/automatic.py:716-724`), so
`drive` ends with `Non-retryable graph failure; inspect retained evidence` (`:822-823`). The operator must type
`python -m workflow retry "$RUN" --phase worker --node <lane>` (or `--phase candidate`) to bump `attempts.json`
(`workflow/pipeline.py:957-969,431-439`), then `automatic "$RUN" --live`. Lost: one of the three attempts, and the time
of that check; the sibling lanes' packets are kept and reused because a packet that already exists for the current
attempt is rechecked rather than rerun (`workflow/checks.py:147-151`). Untested: no test interrupts a running check.
Whether LangGraph records the sibling lane's successful write when a parallel task dies from `KeyboardInterrupt`
rather than an `Exception` is not asserted anywhere; `test_failed_check_reuses_worker_and_successful_sibling` covers
an ordinary exception only.

**Interrupted while the cherry-pick builds the candidate.** `candidate` writes `candidate.json` only after every
cherry-pick succeeded (`workflow/pipeline.py:485-494`). An interruption before that leaves `$RUN/candidate/` and the
next attempt refuses with `Partial candidate worktree exists; inspect before recovery` (`:486-487`). There is no
command that removes it; the operator has to `git worktree remove` it by hand and rerun. The same window exists for the
review worktree: `Partial review worktree exists; reconcile rather than overwrite` (`workflow/automatic.py:400-402`)
whenever `review-worktree/` exists but `automatic-review.json` was not yet written (`:513`). Both are untested.

**Interrupted while the reviewers are running (native transport).** `_accept_native` catches `KeyboardInterrupt`,
writes one `interrupted` event and re-raises; the sessions are not stopped (`:584-588`). On resume `review_candidate`
finds the combined status `running` (or `needs_reconciliation`) for the same bundle digest, rebinds every receipt
through `rebind_reviewers` and waits again (`:395-398,413-439`). Inside the launch window: a reviewer whose
`claude --bg` was issued has a receipt; the controller records what was bound and resume reconciles the rest
(`:535-543`). A reviewer whose launch was never issued has no receipt; the run goes to `needs_reconciliation` and
resume launches nothing, so the run cannot continue (`:522-534,421-425`). Tested, once per transport and once with two
reviewers: `NativeReviewerGraphTests.test_interrupted_reviewer_wait_keeps_the_reviewers_and_resumes_in_a_new_process`
(exit codes 75, 130, 75, 0 across real processes), `..test_interrupt_after_launch_with_a_bound_session_resumes_the_same_reviewer`,
`..test_interrupt_inside_the_settle_poll_reconciles_the_reviewer_then_resumes`,
`..test_interrupt_before_the_launch_was_issued_needs_reconciliation`, `ParallelReviewerScenarios.test_interrupted_launch`.

**Interrupted while the reviewers are running (print transport).** `_review_print` catches every `BaseException`,
including `KeyboardInterrupt`, terminates every reviewer process, records `blocked` and re-raises (`:673-682`). On
resume `review_candidate` sees a `blocked` print status and stops with
`Prior reviewer invocation needs reconciliation; no automatic relaunch` (`:395-399`). A Ctrl-C during a print review
therefore ends the run. Neither `workflow/RUNBOOK.md` ("Interruption" and "Print fallback" bullets) nor
`workflow/CHEATSHEET.md` section 3 ("workers and the reviewers keep running meanwhile") says so; the cheatsheet's
sentence is wrong for print transport. Untested.

**After a reviewer's file was accepted but before the decision was persisted.** `wait_reviews` marks the reviewer
`accepted` in its status file but keeps the decision only in `state.decisions` (`:370-372`); it becomes durable in
`_decide` (`record_decisions`, `:480`) or `_record_partial` (`:496-501`). A resumed controller builds a fresh
`ReviewStatus` with empty decisions (`:265-272,258`), so the accepted file is read again: the reviewer's session must
still be located, be `idle` or `done`, and its deadline must not have passed (`:351-363`). Lost: the original
`accepted_at` (overwritten, `:371`), and the whole review if that session has since exited
(`Native reviewer <id> missing; reconciliation required`, `:355-357`) or its deadline passed while the controller was
away (`:351-354`). Untested: every interruption test interrupts before the first acceptance.

**During integration.** `integrate` writes `integration-intent.json` before `git merge --ff-only` and, on re-entry,
returns the candidate when the intent matches and `HEAD` is already the candidate (`workflow/pipeline.py:551-564`).
An interruption between the intent and the merge reruns the merge from the pinned `base_commit` check (`:561-564`).
In automatic mode a failed `integrate` task is not in the retryable set (`workflow/automatic.py:706`), so `drive`
reports `Non-retryable graph failure`; the documented path is `python -m workflow retry "$RUN"` without `--node`,
which re-invokes the graph (`workflow/pipeline.py:957-972`), then `automatic --live`. Untested: no test interrupts or
fails `integrate`, and no test asserts that `retry` re-drives a node that raised after consuming its resume value.

**Deadlines on resume.** Both waits check the deadline before looking for a completion file
(`workflow/automatic.py:118-120,351-354`). A worker that wrote its file at 3h59 of a 4h deadline and a controller
resumed at 4h01 ends with `Worker <lane> deadline exhausted; no automatic relaunch` and every worker is stopped
(`:809-818`). `features/project-workflows/README.md` says deadlines are "enforced only while the supervisor is
running"; that is true of the stop, not of the clock. Untested.

### What is documented as retained but not resumable

`workflow/CHEATSHEET.md` section 3 lists deadline, blocked worker, quota block, rejected completion file and blocked
review. The mechanism is implicit: once `drive` has stopped the workers (`:812-816`), the next `wait_handoffs` takes
the stop-intent branch (`:106-111`) and `read_completion` raises for any lane without a valid completion file, so a
resume reports `Invalid completion file for <lane>` rather than the original reason. For reviews, a `blocked` status
file makes `review_candidate` raise `Prior reviewer invocation needs reconciliation` (`:399`). Nothing marks a run as
terminal; the operator learns it by trying. The relaunch command that `parallel-reviewers-001` used (events 8-13,
`relaunched/<lane>/1/`) is commit `312a96d` on the unmerged branch `fix/worker-relaunch`; it is not in this tree, so a
run whose workers were stopped has no continuation today.

### Gaps and what I would change

- The verifier and cherry-pick interruptions are the only places where a crash forces a manual command with no
  integrity reason: the interrupted attempt has no evidence to protect. Recommendation 1 and 8 below.
- Deadline-before-file ordering turns a controller outage into a lost run. Recommendation 2.
- Accepted reviewer decisions should be durable at acceptance. Recommendation 4.
- Print-transport reviews are not resumable and the docs say the opposite. At minimum the runbook and cheatsheet must
  say it; Recommendation 6 removes the asymmetry.
- Good practice (LangGraph interrupts with idempotent nodes) is followed for handoff, freeze, review and integrate,
  each guarded by a durable marker; the verifier is the one node without a marker for "started but not finished".

## 2. Failed checks

**Answer.** Nothing ever goes back to a worker: workers are stopped before any check runs, every retry reruns the same
immutable snapshot commit, and a failure at the cap or an identical repeat ends the run so the operator starts a new
run with changed code. A lane whose own checks passed is not rerun when a sibling fails, but the run as a whole waits,
and in the candidate phase every lane is checked again on the combined revision.

### How it works

`freeze` validates the handoffs, calls `stop_workers` and only then snapshots (`workflow/pipeline.py:372-381`). Each
`verify_<lane>` node checks `snapshots[lane]["commit"]` (`:446-450`) in a fresh worktree at that commit
(`workflow/checks.py:154-158`). The prompt sent to workers says the controller's checks decide acceptance
(`workflow/automatic.py:72-74`), and no code path writes to a lane's worktree or session after freeze.

**Worker-phase gate.** `evaluate_worker` gates every lane-local kind (`unit`, `contract`, `integration`) and verifies
argv, worktree and timeout for every check (`workflow/verification.py:161-170,173-176`); `build` and `browser`
checks are executed and recorded but their outcome is deferred (`DEFERRED_WORKER_KINDS`, `:25,151-153,159,171-172`),
and `recheck_packet` keeps a deferred check's capture errors out of the gate (`workflow/checks.py:269-273`). The verify
event says `recorded for the candidate gate: ...` (`workflow/pipeline.py:466-469`). Tested:
`VerificationTests.test_worker_phase_records_build_and_browser_without_gating`,
`..test_worker_phase_still_checks_deferred_command_integrity_and_lane_local_kinds`,
`..test_recheck_packet_keeps_deferred_capture_errors_out_of_the_worker_gate`.

**Combined-candidate gate.** `candidate` first rechecks every worker packet (`Worker evidence no longer passes`,
`:476-480`), cherry-picks the selected lanes in declared order onto `base_commit` (`:488-492`), then runs every lane's
checks on the combined revision with `phase="candidate"`, where nothing is deferred (`:495-505`,
`workflow/verification.py:151-152`). The loop raises at the first failing lane (`:503-504`), so lanes later in
declared order are not checked in that attempt. Tested: `VerificationTests.test_candidate_phase_gates_on_build_and_browser`;
the end-to-end runs in `ThreeLaneRun`, `PipelineTests` and `SharedGraphTests` produce candidate packets per lane.

**Attempt limit.** `attempt` and `retry_check` read and write `attempts.json`, capped by
`policy.max_verification_attempts` (default 3; `:424-439`); `validate_policy` requires at least two attempts when a
drill is configured (`workflow/verification.py:90-92`). Tested:
`PipelineTests.test_configured_failure_drill_reopens_checkpoint_and_enforces_attempt_cap`.

**Automatic retry and the identical-failure stop.** `advance_failed_checks` (`workflow/automatic.py:700-735`) retries
only pending `verify_<lane>` or `candidate` tasks whose current packet is not `passed`; before bumping it compares the
gate reasons of attempts N-1 and N with the attempt directory neutralised (`gate_reasons`, `:691-697`) and stops with
`<phase>/<node> failed identically on attempts N-1 and N; not transient, inspect <packet>` (`:718-723`); it checks
every target against the cap before changing any counter (`Verification retry limit exhausted; work and evidence
retained`, `:730-732`). Tested: `CompletionTests.test_identical_failures_are_not_retried` (including a path-bearing
reason), `..test_stale_error_on_a_completed_sibling_does_not_block_retry`,
`RetryAnyLane.test_advance_failed_checks_knows_every_selected_lane`,
`SharedGraphTests.test_recovery_in_actual_new_controller_processes` (drill retried in a new process, `adapter: [1, 2]`).
Recorded: `parallel-reviewers-001` burned candidate attempts 1-3 with byte-identical reasons apart from the attempt
path (events 23-28, `verification/candidate/ui/{1,2,3}/packet.json`); commit `3c7354c` added the neutralisation and
the path-free "no Playwright report written" reason (`workflow/checks.py:246-249`).

**Sibling lanes.** The verify fan-out runs in parallel (`workflow/pipeline.py:711-713,721`). When one lane fails,
LangGraph keeps the successful sibling's write and only the failed task reruns; the sibling's packet digest is
unchanged and no second attempt directory appears. Tested: `PipelineTests.test_failed_check_reuses_worker_and_successful_sibling`,
`RetryAnyLane.test_retry_reruns_only_the_failed_lanes_check`. The passing lane is still affected in the sense that
the run does not proceed to candidate until every lane passes, and its work is rechecked in the candidate phase.

**What the operator does after a candidate failure.** Nothing for the first two attempts: the supervisor restarts and
retries. After the identical-failure stop or the cap, the operator inspects the packet, and: for an environment
fault at the same revision, `retry "$RUN" --phase candidate --node <lane>` then `automatic --live` (the manual `retry`
does not apply the identical-failure comparison, `workflow/pipeline.py:957-969`); for a code fault, a new run.
Recorded practice diverges from the runbook: in `worker-lanes-001` and `project-workflows-001` the operator moved the
attempt directories aside (`verification-attempts-1-3-tmpdir-bug/`) and reset `attempts.json` by hand (events 22-25
and 23-27 respectively show "Attempt 1" running again). Nothing in the controller detects that: `attempts.json` and
the packet directories are plain files with no digest of their own. The cap is therefore a convention, not an
integrity boundary.

### Gaps and what I would change

- Candidate checks stop at the first failing lane, so a later lane's failure is only discovered on the next attempt.
  Running every lane and raising once would use one attempt for the whole picture; it changes no boundary.
- The manual `retry` bypasses the identical-failure comparison; that is acceptable because it is an explicit operator
  act, but the runbook should say so.
- Bounded retries are in place; the automatic retry does not distinguish an environment failure (missing browser,
  `npm ci` failure) from a code failure, so environment failures on immutable code cost a run.

## 3. Worktree safety

**Answer.** Worktrees are isolated from the source checkout by path and by the pinned revision, ownership is enforced
from the captured Git tree rather than from any report, snapshots are content-addressed commits, and every packet and
artifact is hashed and rechecked at review, approval and integration. None of this is a sandbox: every worktree shares
the source repository's object database and every file is writable by the same Unix user, so a worker with Bash can
alter any lane's tree, the source checkout or the run directory, and only some of that is detected.

### How it works

**Isolation.** `prepare` refuses a run directory inside the repository (`workflow/sessions.py:189-190`), creates it
`0700` (`:191-192`), and adds one detached worktree per selected lane at the verified revision, checking `HEAD` and a
clean status (`:202-205`). `ClaudeSessions.__init__` re-verifies worktree paths and start revision on every load
(`:233-238`). Each lane's session runs with `cwd` at its worktree and a private `TMPDIR` (`:274-276`,
`workflow/interactive.py:143-152`). Verification worktrees are fresh per phase, lane and attempt
(`workflow/checks.py:154-158`) with private `XDG_CACHE_HOME`, `npm_config_cache`, a short private `TMPDIR` that is
removed afterwards, `HERDR_*` and `PLAYWRIGHT_JSON_OUTPUT*` stripped, `CI=1` (`:162-185`); checks run with
`shell=False`, `stdin=DEVNULL`, a new session and process-group kill on exit or timeout (`:25-49`). The candidate is a
detached worktree at `base_commit` with hooks disabled during cherry-pick (`workflow/pipeline.py:488-492`); the review
worktree is detached at the candidate commit (`workflow/automatic.py:403`). Tested: `SessionTests.test_exact_revision_and_distinct_worktrees`,
`..test_lock_and_dirty_worktree_fail_closed`, `PipelineTests.test_complete_offline_graph_with_real_browser_and_explicit_gates`
(tmpdir length and removal), `InteractiveTests.test_reviewer_launch_requires_the_clean_candidate_worktree`.

**Ownership against captured files.** `freeze` computes `changed_files` from `git diff --name-only` against
`base_commit` plus untracked files not ignored (`workflow/pipeline.py:211-214,390`), refuses a moved `HEAD`
(`Worker changed HEAD`, `:388-389`), checks each path with `safe_path` (no `..`, no absolute, no wildcards;
`workflow/verification.py:38-42`) against the lane's prefixes with `owns` (`:45-46`) and against every excluded lane's
prefixes (`Ownership violation: <lane> edited <path>, owned by excluded lane <other>`, `:383,393-397`), refuses
symlinks (`:398-399`), stages into a private index (`GIT_INDEX_FILE`, `:400-407`) and then requires the captured tree's
diff to equal the list it checked (`Files changed during snapshot; refuse inconsistent evidence`, `:409-411`).
`evaluate_worker` re-applies ownership to the packet's `changed_files` in the worker phase (`:128-131`). Tested:
`PipelineTests.test_ownership_violation_blocks_snapshot`, `SubsetSelection.test_selected_lane_touching_an_excluded_lanes_path_blocks_at_freeze`,
`VerificationTests.test_overlapping_ownership_and_unsafe_paths_are_rejected`, `..test_path_prefix_is_not_a_glob`.
Untested: the symlink refusal and the changed-during-snapshot check.

**Immutable snapshots.** The snapshot is `commit-tree` on the captured tree with a fixed author (`:412-415`), pinned
under `refs/workflow/<sha256(run dir)[:16]>/<lane>` (`:416-417`) and recorded by SHA in `snapshots.json` with the
lane's native session id (`:418-420`). The worker's own `HEAD` and index are untouched. Verification, candidate and
review all address the SHA. A commit is immutable by construction; its reachability is not: the ref lives in the
shared `.git` and nothing protects it from `git update-ref -d` or a later `gc` once the ref is gone. Untested beyond
the end-to-end runs.

**Evidence hashing and recheck.** `Capture.add` copies each artifact under a hash-bearing id, `0400`, and records its
SHA-256 (`workflow/checks.py:82-97`). `evaluate_worker` resolves artifacts inside the registry root and recomputes
hashes (`workflow/verification.py:132-143`), checks PNG headers (`:191-195`) and distinct screenshots (`:196-197`).
The bundle records each packet's SHA-256 (`workflow/pipeline.py:509`); `validate_bundle` re-hashes every packet,
requires it inside the run directory and re-evaluates its gate (`:524-536`), and is called at review entry
(`:675`), by `validate_review` (`:538-541`), at approval (`:687,943`) and integration (`:544`). `review.diff` is hashed
into the status file and rechecked, and the review worktree must still be clean at the candidate commit
(`workflow/automatic.py:579-582,668-671`). Tested: `PipelineTests.test_failed_check_reuses_worker_and_successful_sibling`
(tampered artifact refused), `VerificationTests.test_tampered_artifact_and_registry_escape_block`,
`NativeReviewerTests.test_reviewer_worktree_change_is_refused`, `..test_evidence_change_during_review_is_refused`.

**Worktrees after a run and stale registrations.** Nothing deletes worktrees (`workflow/RUNBOOK.md`, "Stopping an
unfinished run"). Each is registered in the source repository's `.git/worktrees/`; at audit time the source checkout
lists 33 registrations, none prunable, seven `refs/workflow/*` refs. `export` works when worktrees are gone
(`ExportRuntime`, `workflow/pipeline.py:569-597`; `ExportRunTests.test_legacy_run_directory_re_exports_to_current_version_and_stays_stable`).
A stale registration cannot collide with a new run because every path embeds the run id, phase, lane and attempt;
`git worktree add` at a registered path fails, which is how `Partial candidate worktree exists` and `Interrupted
check attempt exists` surface (`:485-487`, `workflow/checks.py:152-153`). There is no `prune` step and no test.

**What a worker can do to another lane's tree or the source checkout.** In automatic mode a worker has
`--tools Read,Glob,Grep,Edit,Write,Bash --permission-mode bypassPermissions --dangerously-skip-permissions`
(`workflow/interactive.py:189-191,201-206`), no `--add-dir` restriction and the account's shell. It can write into
another lane's worktree (detected only if the write lands outside that lane's owned paths, and then blamed on that
lane at freeze), write into the source checkout (detected as `Source worktree is dirty` at integration,
`workflow/pipeline.py:554-555`, and `No verified feature-branch completion` at the end of `drive`,
`workflow/automatic.py:790-794`; not detected before), run any `git` command against the shared repository
(reset the source branch: detected by `Source advanced since preparation` and `Source branch changed`, `:552-553,561-562`;
delete refs or worktrees: not detected), and write anything in the run directory (see section 6). The
`RUNBOOK.md` "Guarantees and boundaries" says plainly this is a trusted local tool, not a sandbox; that statement is
accurate.

### Gaps and what I would change

- `refs/workflow/*` should be verified to still resolve to the recorded SHA at `validate_bundle` time, and the
  candidate should be re-derivable from `snapshots.json` alone.
- The symlink and changed-during-snapshot refusals need tests; they are the two ownership guards without one.
- A `workflow prune` that removes only worktrees whose run directory no longer exists would keep the source
  repository's registry bounded; it changes no evidence.
- Least privilege is honoured for reviewers and verifiers, not for workers; that is a documented decision, and the
  document should stop calling worktrees "isolation" for workers.

## 4. Blocked and stuck sessions

**Answer.** A session in native state `blocked` (question, permission prompt, refusal) is waited for until its own
deadline, announced once on the timeline; a session missing from the inventory ends the run at once; a session that
never writes its completion file ends the run at its deadline. The attention path is tested with a fake inventory and
therefore proven without a live session, but only at the wait-loop level and only for the state word the code
expects.

### How it works

`wait_handoffs` (`workflow/automatic.py:113-141`) per lane and per two-second poll: raise at the deadline
(`Worker <lane> deadline exhausted; no automatic relaunch`, `:118-120`); raise if `locate` returns `None`
(`Native worker missing; reconciliation required`, `:121-123`); on state `blocked` write one `interactive` event
`Worker <lane> needs attention in its pane (native state blocked); waiting until its deadline` and keep polling
(`:124-133`); accept a completion file only when the state is `idle` or `done` (`:134-136`). `read_completion` raises
`Worker <lane> explicitly blocked: <summary>` for a file with `status: blocked` (`:92-93`). In `drive` every exception
other than `KeyboardInterrupt` is recorded as `blocked`, the workers are stopped and the step exits non-zero
(`:809-818`), which the supervisor turns into `Automatic controller blocked (exit 1)` (`:750-751`).

`locate` (`workflow/interactive.py:64-105`) returns `None` when the receipt or the inventory row is absent, raises on a
changed plan digest, an ambiguous or foreign row, a changed UUID, a state outside `idle|working|blocked|done`
(`:96-97`) or a dead PID (`:98-104`). A raise inside the poll is treated like any other failure: the run stops. The
recorded run `worker-lanes-001` event 6 shows an inventory error (`claude` not on `PATH`) ending the wait this way.

`wait_reviews` mirrors this for reviewers with the reviewer's own deadline (`:351-354`), missing session
(`:355-357`), `blocked` announcement (`:358-362`) and idle-only acceptance (`:363`); `_accept_native` then stops every
reviewer on any failure (`:589-599`).

Permission prompts cannot occur for workers (permissions are bypassed) and cannot block a reviewer (mode `dontAsk`
denies silently); what the native harness reports as `blocked` for them is a question or a refusal. The controller
does not read transcripts, so it cannot tell which.

### What proves it

- Attention path: `CompletionTests.test_blocked_worker_waits_for_attention_instead_of_ending_the_run` (fake inventory
  rows: one event, sibling keeps running, deadline ends it, and a later `idle` accepts the file);
  `ReviewCompletionTests.test_wait_accepts_only_idle_reviewers_with_files_and_never_relaunches` (same for
  reviewers, including `working` and `done`). Both use `SimpleNamespace` sessions, so yes, provable offline. Neither
  drives the graph: no test asserts that `drive` leaves the other lanes running after a `blocked` sighting; the
  drive-level test `test_deadline_or_blocked_worker_stops_workers` injects the deadline error directly.
- Never writes a file: `CompletionTests.test_idle_without_signal_times_out_not_completes`,
  `..test_completion_while_working_is_not_accepted`,
  `NativeReviewerTests.test_reviewer_deadline_without_a_file_stops_the_reviewers_and_launches_no_second`,
  `ParallelReviewerScenarios.test_one_times_out`.
- Explicit `blocked` file: `CompletionTests.test_foreign_and_blocked_signals_fail_closed`.
- Missing from inventory: reviewers, in `test_wait_accepts_only_idle_reviewers_with_files_and_never_relaunches`
  (`del self.rows[last]`) and `NativeReviewerTests.test_reviewer_missing_after_the_file_is_refused`; workers, untested
  (`Native worker missing` appears in no test).
- That the live `claude agents --json` reports the word `blocked` is assumed from `locate`'s allowed set; commit
  `3c7354c` says it was seen live in `parallel-reviewers-001` (event 6 carries the pre-fix message).

### Gaps and what I would change

- `Native worker missing` tells the operator to reconcile, but `reconcile` only handles pending `launch_*` steps
  (`workflow/pipeline.py:948-956`); during the handoff wait there is no reconciliation command, so this is a terminal
  condition dressed as a recoverable one. A session that exited after writing a valid completion file should be
  accepted, since the snapshot comes from the worktree, not the session (Recommendation 3).
- Transient inventory failures (timeout, `claude` missing) end the run; they should be retried for a bounded number
  of polls (Recommendation 7).
- The `attention` event maps to viewer status `running` (`server/projects.ts:329-333`), so the viewer cannot show
  that a lane is waiting for a human (Recommendation 9).

## 5. Session identity and reconciliation

**Answer.** A completion file is accepted only when its `launch_token` equals the token pinned in `plan.json` at
prepare (workers) or generated per reviewer per review (reviewers), the run id and node id match, and the session the
receipt binds is present in the native inventory and idle. The controller never learns which process wrote the file;
the token is a shared secret readable by every same-user process, so identity is "the operator's environment attests
it", as the runbook says.

### How it works

- **Launch tokens.** `prepare` stores a `uuid4` under `plan.nodes[<lane>].session_id` (`workflow/sessions.py:199-200`);
  despite the key name it is the launch token, copied into the receipt as `launch_token`
  (`workflow/interactive.py:180`) and into the worker's prompt (`workflow/automatic.py:63-74`). Reviewer tokens are
  fresh `uuid4` per reviewer per review, stored in the status file and the prompt (`:510,519`).
- **Receipts.** `run` writes the receipt before issuing `claude --bg` (`workflow/interactive.py:180-184`), so an
  existing receipt is proof that a launch may have happened and forbids a second one (`:172-173`). `launch` runs the
  helper once, then `settle` polls for the exact row (`:143-165,107-129`); on any failure the receipt is
  `needs_reconciliation` (`:160-162`).
- **Native UUIDs.** `locate` binds by `background_id` (from the receipt or, before it was bound, from the single
  `claude attach <id>` line in the launch log; `:70-81`), then requires kind `background`, the node's worktree as
  `cwd`, the expected name, an unchanged `sessionId`, a well-formed UUID, an attachable state and a live PID
  (`:82-105`). The bundle's `snapshots[<lane>].session_id` is the native UUID from the receipt (`workflow/pipeline.py:418-419`).
- **Completion binding.** Workers: `read_completion` (`workflow/automatic.py:77-94`). Reviewers:
  `read_review_completion` validates the schema, then run id, node id, that reviewer's token, bundle digest and
  candidate commit, then the finding vocabulary (`:295-317`).
- **Independence.** `check_independence` requires each reviewer's located row to carry the recorded UUID, distinct
  from every worker UUID in the bundle and from every other reviewer (`:557-566`); `check_reviewers` and
  `check_review` re-apply the distinctness rules on the persisted record (`workflow/pipeline.py:108-131,145-147`).
  Print reviewers get controller-generated UUIDs passed with `--session-id` and echoed back in the result
  (`workflow/automatic.py:617,633,654`).
- **reconcile.** CLI `reconcile` only accepts a run whose `state.next` still has `launch_*` steps with receipts and
  calls `sessions.run`, which rebinds through `reconcile` and never launches (`workflow/pipeline.py:948-956`,
  `workflow/interactive.py:131-141`). Reviewers are rebound by `rebind_reviewers` and `Pipeline.reconcile_reviewer`
  (`workflow/automatic.py:413-439`, `workflow/pipeline.py:313-326`).
- **Stops.** `stop_session` persists the intent (`background_id`, `session_id`, `pid`) before signalling, re-locates
  and refuses a changed identity, then requires the UUID and PID to be gone (`workflow/pipeline.py:328-354`);
  `stop_workers` additionally refuses a restarted UUID (`:356-362`).
- **What a relaunched attempt archives.** Not in this tree. On branch `fix/worker-relaunch` (commit `312a96d`),
  `relaunch_worker` moves `<lane>.interactive.json`, `<lane>.launch.log`, `<lane>.prompt.txt` and `<lane>.stop.json`
  to `relaunched/<lane>/<attempt>/`, refuses a lane with a completion or handoff file, an unconfirmed stop or a
  still-alive session, launches once and sets `attempt + 1` on the new receipt. The launch token is not rotated
  (`plan.json` is unchanged), which the recorded `parallel-reviewers-001/relaunched/adapter/1/adapter.interactive.json`
  confirms (same `launch_token` as the live receipt). `worker-lanes-001` event 11 ("Operator attests native session
  ... is idle") matches no commit in the repository; it was appended out of band.

### What proves it

`InteractiveTests.test_native_launch_and_reconciliation_never_spawn_duplicate`, `..test_launch_waits_for_native_pid_to_register`,
`..test_launch_gives_up_when_pid_never_registers_without_relaunch`, `..test_launch_identity_mismatch_fails_immediately`,
`..test_ambiguous_launch_never_retries_when_session_missing`, `..test_launch_intent_can_reconcile_exact_surviving_session`,
`..test_foreign_or_exited_sessions_cannot_be_attached`, `..test_locate_reviewer_binds_the_review_worktree`;
`CompletionTests.test_foreign_and_blocked_signals_fail_closed`; `ReviewCompletionTests.test_stale_foreign_or_malformed_completions_fail_closed`
(wrong bundle, token, candidate, run, node, other reviewer's token, version, extra key, verdict, lane, `both`, missing
link, empty requirement, malformed JSON, symlink); `NativeReviewerTests.test_reviewer_identity_changed_after_the_file_is_refused`,
`..test_reviewer_that_is_a_worker_session_is_not_independent`, `ParallelReviewerScenarios.test_shared_identity`,
`..test_wrong_node`; `PipelineTests.test_native_reviewer_stop_rechecks_identity_and_records_intent`,
`..test_failed_stop_and_lingering_pid_block_freeze`. Untested: the CLI `reconcile` action itself, and any relaunch
(its tests live on the unmerged branch).

### Gaps and what I would change

- The worker token is stored in `plan.json` under a key named `session_id`, which every worker can read with its
  file tools. Section 6 covers the consequence. Renaming the key would remove a standing source of confusion.
- Print transport skips `check_independence`; the persisted record is still checked by `check_reviewers`, so the
  gap is only that a print reviewer's row is never compared against a live inventory (there is none).

## 6. Permissions and blast radius

**Answer.** A worker can execute anything the account can and write anywhere the account can; a reviewer can read the
candidate worktree and the run directory and write exactly one file; nothing technical stops a worker from
committing, pushing, editing another lane's files or the run directory, only detection at freeze and integration, the
prompt text, and the fact that the source branch is a `feature/` branch that nobody merges.

### What each session gets

| Session | Command line | Effective authority |
| --- | --- | --- |
| Worker, manual mode | `claude --bg --name workflow-<run>-<lane> --safe-mode --strict-mcp-config --mcp-config {} --tools Read,Glob,Grep,Edit,Write --permission-mode manual <prompt>` (`workflow/interactive.py:189-206`) | file tools with operator prompts, no shell, no MCP |
| Worker, automatic mode | same plus `,Bash`, `--permission-mode bypassPermissions --dangerously-skip-permissions` (`:190-191,203-205`) | full shell as the account; prompt says do not commit, push, launch agents or leave the worktree (`:192-195`, `workflow/automatic.py:67-74`) |
| Native reviewer | `claude --bg --name workflow-<run>-reviewer[-<id>] --safe-mode --strict-mcp-config --mcp-config {} --tools Read,Glob,Grep,Write --allowedTools Edit(//<run>/<node>.completion.json) --add-dir <run> --permission-mode dontAsk <prompt>` (`:238-245`) | read candidate worktree and run directory; one permitted write |
| Print reviewer | `claude --print --output-format json --session-id <uuid> --safe-mode --strict-mcp-config --mcp-config {} --tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none --add-dir <run> --json-schema <schema>` (`workflow/automatic.py:633-636`) | read only; verdict through structured output |
| Verifier | policy `setup` and `checks` argv, `shell=False`, isolated env, per-check timeout, process-group kill (`workflow/checks.py:25-49,218-259`) | whatever the committed policy commands do, as the account |

`HERDR_*` is stripped from every launch environment so a session cannot drive the operator's terminal
(`workflow/interactive.py:145`, `workflow/checks.py:162`, `workflow/sessions.py:274`). `preflight` only checks that the
CLI advertises the flags (`workflow/pipeline.py:803-810`); what `--safe-mode` does is not verified by any code or test
in this repository. Tested: `InteractiveTests.test_automatic_permission_bypass_is_run_scoped`,
`..test_native_launch_and_reconciliation_never_spawn_duplicate`, `..test_reviewer_launch_is_read_only_except_its_completion_file`
(the flags, their order, cwd and environment), `GraphFixture` fake reviewer (asserts print jobs get
`Read,Glob,Grep` and no bypass). Untested: that `dontAsk` plus the `Edit(//path)` rule denies every other write; the
comment at `workflow/interactive.py:234-237` says it was observed live, nothing asserts it.

### What stops a worker

- **Committing.** Nothing prevents it; freeze refuses a moved `HEAD` (`Worker changed HEAD`,
  `workflow/pipeline.py:388-389`) and the run ends. A worker that commits and then resets `HEAD` back leaves no
  trace the controller checks.
- **Pushing.** Nothing. The source repository has an SSH `origin` with push access, every lane worktree shares its
  configuration, and `git push` is one Bash call. The controller itself never pushes (no `push` anywhere in
  `workflow/`; `SharedGraphTests.test_automatic_drill_review_and_feature_only_finish` asserts the test repository has
  no remote, which says nothing about the real one).
- **Editing another lane's files.** Nothing prevents it. Detected at that lane's freeze only if the path is outside
  that lane's ownership; a write inside the sibling's owned paths is captured as the sibling's work and verified and
  reviewed as such.
- **Editing the run directory.** Nothing prevents it. Consequences by file: `plan.json` or `policy.json` changes are
  caught by digest (`workflow/interactive.py:69-70`, `workflow/pipeline.py:257-258`); its own completion file is the
  intended channel; a sibling's completion file can be forged because the sibling's token is readable in `plan.json`
  and `read_completion` binds to the token only (`workflow/automatic.py:85-87`), which would freeze the sibling's
  unfinished worktree once that sibling's session is idle; `events.jsonl`, `attempts.json` and, later, packets and
  bundle are unprotected before the hashes that bind them exist, and a detached background process left by the
  worker (Bash, `nohup`) survives `stop_session`, which checks the session's PID and UUID only
  (`workflow/pipeline.py:340-352`), and could rewrite evidence after the hashes were computed if it also rewrites the
  bundle and status files. All of this is the same-user trust the runbook declares.

### Hostile repository content

Task text is committed configuration and pinned into the plan (`workflow/pipeline.py:830-834`); READMEs, test
fixtures and source files are read by the worker with no filtering. A prompt injection in any of them is executed by
a worker with the account's shell; the limits are the ones above (detection at freeze and integration, review, no
automatic merge to main, no push by the controller). For a reviewer, hostile content can at most change the verdict
it writes, since it has no shell and one permitted write; the brief instructs it to treat repository content as data
(`workflow/prompts/review.md`), and a wrong approval is caught by nothing else. A reviewer can read the other
reviewers' completion files through `--add-dir` (the prompt tells it not to, `workflow/automatic.py:221-223`);
independence between reviewers is by instruction. The verifier executes policy `setup` and `checks` from the
candidate revision, so a worker can change what those commands do by editing files they read (a Playwright config, a
test file under its owned paths); the argv is fixed, the code behind it is the candidate's.

### Gaps and what I would change

- Rotate or remove the shared-secret property of worker tokens: put each lane's token only in its own prompt file
  (`0600`, already) and not in `plan.json`, or bind acceptance to the session transcript. Small change in
  `workflow/sessions.py:prepare` and `workflow/automatic.py:read_completion`.
- Record the `origin` URL at prepare and, at freeze, compare `git rev-parse origin/<branch>` before and after; a
  pushed branch would then at least be detected.
- State in the runbook that "worktree isolation" for automatic workers means path separation, not confinement.

## 7. Parallel reviewers

**Answer.** Every declared reviewer runs in parallel over one shared review worktree, each with its own token, receipt,
completion file, status file, pane and deadline; the verdict is unanimous, the first accepted block, rejected file or
expired deadline decides at once and the others are stopped and marked `superseded`. Print transport differs in
collection order, in what a Ctrl-C does, in identity checks and in the absence of files, panes and human input.

### How it works

- **Declaration and briefs.** `plan.reviewers` from `feature.json` 2.1.0 (`workflow/launch.py:42-50`,
  `workflow/pipeline.py:86-100`); absent means the single default reviewer `review` (`workflow/sessions.py:64-68`).
  Each brief is followed by the same fixed blocks and a completion protocol naming that reviewer's node, token, file
  and the other reviewers (`workflow/automatic.py:201-235`).
- **Launch.** `_review_native` writes the combined status and one status per reviewer with fresh tokens, then
  launches sequentially in declared order, saving after each (`:504-554`). Sessions share `review-worktree`
  (`workflow/interactive.py:58-62`).
- **Waiting and unanimity.** `wait_reviews` polls all receipts each round; a reviewer's file is accepted when its
  session is idle and the file binds; `decision_blocks` (verdict not approved, or any unresolved P0/P1) returns
  immediately (`:363-374`); otherwise it returns when every reviewer has an accepted decision (`:375-376`).
- **Decision.** `combined_review` writes one entry per declared reviewer in order (`verdict` null when none), the
  union of findings tagged with `reviewer`, `reviewer` as the comma-joined UUIDs, `verdict: blocked` if any reviewer
  is undecided or blocks (`:459-473`); `_decide` persists `review.json` for any verdict, marks blockers `blocked`
  and, on unanimity, every reviewer `succeeded` (`:476-493`). `supersede_running` marks reviewers still
  `pending|launching|running` as `superseded` when the run is decided (`:288-292`); `_record_partial` keeps decisions
  accepted before a deadline or rejection (`:496-501`).
- **Per-reviewer deadlines.** Each counts from its own receipt's `launch_requested_at` (`:338-341,351`); the first
  expiry raises, others' accepted verdicts are retained (`:352-354,595-596`).
- **Stops.** After any decision every reviewer is stopped, failures collected (`:448-456,597-598,600-605`); an
  unconfirmed stop after a successful decision is retried by a resumed controller (`:387-394,761-773`).
- **Manual import per reviewer.** `review --reviewer <id> --review-file <file>` stores `<node>.imported.json` and
  waits until every declared reviewer is imported, then `combine_imported_reviews` produces the same record shape
  (`workflow/pipeline.py:906-935,178-188`); `approve` refuses until then (`:936-947`).
- **Panes.** One pane per reviewer in declared order, best effort, a failure recorded but never fatal
  (`workflow/pipeline.py:300-310`, `workflow/interactive.py:374-423`).

### Where print transport differs

`_review_print` (`workflow/automatic.py:609-688`) starts one `claude --print` job per reviewer in parallel, then
waits on them **in declared order** (`:645`): a later reviewer's block is acted on only after every earlier job has
finished or timed out; each job still keeps its own deadline measured from its own start (`:650`). There is no
receipt, completion file, pane, human input or `stop.json`; processes are terminated with `terminate`
(`:674-676,684-686`). Identity is the controller-chosen `--session-id` echoed in the result (`:654`), not an
inventory row, so `check_independence` does not run. Any exception, including a Ctrl-C, terminates all jobs and marks
the review `blocked`; the run is over (`:673-682`, section 1). The structured-output schema is generated from the
run's lanes, so a finding naming a foreign lane fails validation before `check_finding_lanes` (`:159-172,657-658`).

### What proves it

`ParallelReviewerScenarios.test_two_approve`, `..test_one_blocks_while_the_other_is_still_working` (first reviewer
`working`, second blocks: `superseded` and `blocked`, both stopped), `..test_p1_anywhere` (approval with an open P1
recorded as blocked, raw decision kept), `..test_one_times_out` (A's verdict retained), `..test_wrong_node`,
`..test_shared_identity`, `..test_interrupted_launch`; `SharedGraphTests.test_reviewer_block_preserves_branch_and_does_not_relaunch`
(both transports, one and two reviewers); `NativeReviewerTests.test_unconfirmed_stop_after_acceptance_keeps_the_verdict_and_is_retried_on_resume`;
`TwoReviewerCompletionTests` (every acceptance case with two reviewers); `PrintReviewerTests.test_print_mode_never_starts_a_native_reviewer`,
`..test_print_findings_carry_worker_and_requirement_into_review_and_export`,
`..test_print_finding_without_worker_is_rejected_by_the_schema_without_relaunch`;
`DeclaredReviewers.test_manual_import_requires_every_declared_reviewer_before_approval`,
`..test_manual_import_of_the_default_reviewer_keeps_the_single_file_flow`,
`..test_automatic_run_with_declared_reviewers_launches_each_over_the_shared_worktree`;
`InteractiveTests.test_declared_reviewers_get_one_pane_each_in_declared_order_right_of_the_workers`.
Untested: the print collection-order consequence (a later block waiting on an earlier job) and Ctrl-C in print mode.
Recorded: no run with two declared reviewers has completed yet; `workflow-audit-001` (this run) is the first.

### Gaps and what I would change

- Print jobs could be collected with `wait` on any process (poll loop) rather than in order; the runbook documents
  the current order, so this is a small behavioural change with a test that blocks the second job first.
- A blocked reviewer superseding the others discards their findings; the PRD chose this (section 7 of
  `docs/PRD_PARALLEL_REVIEWERS.md`). Their transcripts remain, but nothing in `review.json` records what they had
  found. Recording the other reviewers' files if they already exist at decision time would cost nothing.

## 8. Evidence and the viewer

**Answer.** `run-state.json` is a faithful projection of the checkpoint, the run's own files and the event log at the
moment it was written, hashed where it points to packets; it is not a live view, it can be edited by any same-user
process, and it lags mid-node progress, which the viewer fills from `events.jsonl`.

### How it works

- **What is written and when.** `export_state` (`workflow/export_state.py:218-244`) writes `version` 1.4.0,
  `definition` (kept verbatim if the stored one names the same nodes, `:57-64`), `values` (the LangGraph state
  values), `next`, `tasks` (name, error string, interrupt payloads, pending `result`), the copied `events`,
  `verification_packets` with SHA-256, and the derived `review` and `inputs` sections; `updated_at` only changes when
  the content changed (`:240-243`). `prepare` writes the first one (`workflow/pipeline.py:854`), `report` writes it at
  every CLI boundary and every `drive` step (`:724-728`, `workflow/automatic.py:807,817,836`), `status` calls `report`
  on the current checkpoint (`workflow/pipeline.py:977-980`), and `export` rebuilds it from an `ExportRuntime` that
  validates plan, policy and review but constructs no sessions and touches no worktree (`:569-597,646-656,866-871`).
  `status` and `export` produce the same file; the difference is that `status` needs `Pipeline` (a valid policy and a
  session object, though `report` never calls the CLI) and prints `next`, `pending` and `errors`, while `export`
  works on a run whose worktrees are gone and refuses contradictory files.
- **Legacy carries.** A run recorded before configured lanes has no `plan.workers`; `plan_workers` returns
  `ui, adapter` (`workflow/sessions.py:97-101`) and `carry_legacy_lanes` reads the raw checkpoint channel values
  `<lane>` and `<lane>_packet` into `values.lanes` and `values.packets` (`workflow/pipeline.py:614-643`), for both
  `export` and `report`. `check_review` accepts the legacy `both` attribution only for such runs (`:134-158`).
  A review without `reviewers` is exported as the single reviewer `review` (`workflow/export_state.py:104-122`).
- **Contract versions.** Export 1.4.0 (`EXPORT_VERSION`, `:33`); the adapter accepts 1.0.0 to 1.4.0
  (`server/projects.ts:52`), serves `reviewResult` as contract 1.4.0 (`:534`), `runInputs` as 1.3.0 (`:576`), and
  everything else as 1.0.0. Reviewer status words map `succeeded|accepted -> accepted`, `blocked`, `superseded`,
  anything else `pending` (`workflow/export_state.py:35,117`).
- **Viewer while a run is live.** The adapter opens the run root no-follow, reads `run-state.json` and `plan.json`
  with byte limits, checks run id and base commit agree (`server/projects.ts:657-672,801-810`), re-hashes every
  registered packet and marks a mismatch untrusted rather than failing the run (`:862-895`), reads `events.jsonl`
  live and tolerates a partially appended last line, falling back to the export's copy (`:898-926`), and derives node
  status with precedence task error, interrupt, evidence, last status event, pending (`:988-1068`). Event statuses map
  `running|interactive -> running`, `blocked -> failed`, `passed|succeeded|approved -> succeeded`,
  `interrupted -> paused`; `stopped` and unknown words are log lines (`:329-333,971`). Absolute paths are redacted in
  every text (`:72`). So while a run is live the viewer shows the last persisted graph state plus every event since,
  including a verify node "running" at its attempt number parsed from the message (`:954-958,996-997`); it cannot show
  a worker waiting for a human (section 4), and it shows a lane's launch node as succeeded from the moment its
  receipt exists, which the feature README warns is not a completed task.

### What proves it

`ExportSectionTests.test_review_section_derives_transport_time_and_diff_from_files`, `..test_inputs_section_pins_plan_policy_and_receipts`,
`..test_legacy_plan_reports_the_recorded_reviewer_transport_or_null`; `ReviewerExportTests.test_two_reviewer_record_exports_one_entry_per_reviewer_with_its_findings_and_times`;
`ExportRunTests.test_legacy_run_directory_re_exports_to_current_version_and_stays_stable`,
`..test_prepared_run_without_checkpoint_exports_the_prepare_shape`, `..test_run_without_policy_exports_null_inputs`,
`..test_malformed_or_contradictory_runs_are_refused`, `..test_export_cli_takes_the_lock_and_launches_nothing`;
`LegacyFeatureAndRun.test_legacy_run_exports_at_the_current_version_with_its_stored_definition_and_lane_evidence`,
`..test_legacy_run_report_carries_lane_evidence_like_export`; `FeatureLaunchTests.test_export_is_stable_until_state_changes`;
the adapter's own `server/projects.test.ts` (not read line by line for this audit; it is the `backend-unit` check of
the project-workflows policy and is outside `npm run test:unit`).

### Gaps and what I would change

- `events.jsonl` is the only record of controller decisions and is append-only by convention; `worker-lanes-001`
  event 11 was appended by hand and is indistinguishable from a controller event. A per-event hash chain seeded from
  the plan digest would make out-of-band lines visible without changing the viewer.
- The export embeds `values`, which carries absolute worktree paths; the adapter redacts, the file does not.
- `report.html` is regenerated from the same data and is the only artefact linking screenshots for a human; it is
  not covered by section 8 questions but shares every property above.

## 9. What ends a run permanently

"Permanent" here means: no `automatic --live`, `retry`, `reconcile` or `review` invocation continues the run without
the operator editing run files or running Git by hand. "Deliberate" means the code comment, runbook or test states the
boundary; "accident" means the outcome follows from the implementation without such a statement.

| Condition (message) | Where | In-run recovery | Verdict |
| --- | --- | --- | --- |
| `Worker <lane> deadline exhausted; no automatic relaunch` | `workflow/automatic.py:118-120` | none; workers stopped | deliberate (bounded lifetime), but the resume-time evaluation is an accident |
| `Worker <lane> explicitly blocked: <summary>` | `:92-93` | none | deliberate |
| `Native worker missing; reconciliation required` | `:121-123` | none (no reconcile path in this phase) | accident: message promises a path that does not exist |
| `Invalid completion file` / `Malformed completion signal` / `Stale or foreign worker completion signal` / `Invalid completion status/summary` / `Invalid completion assumptions` | `:79-91` | none; workers stopped, and the same message repeats on resume | deliberate binding, accidental finality: a worker that mis-wrote one key loses the run |
| `Handoff changed after stop intent` | `:110` | none | deliberate |
| any inventory or `locate` exception during the wait (`Plan changed`, `Ambiguous Claude session identity`, `Native Claude UUID changed`, CLI errors) | `workflow/interactive.py:69-104`, `:42-48` | none if the stop succeeded | accident for transient CLI errors (recorded, `worker-lanes-001` event 6) |
| `Worker changed HEAD`, `Ownership violation: ...`, `<lane> edited unowned path`, `Symlink changes require manual review before snapshot`, `Files changed during snapshot` | `workflow/pipeline.py:388-411` | none in automatic mode (`handoff` is not retryable, `workflow/automatic.py:706`); manual `retry` after fixing the worktree is undocumented for these | deliberate integrity boundary |
| stop failures: `<node> session missing before stop`, `... identity changed after stop intent`, `Stop failed for <node>`, `<node> termination is not established`, `A stopped worker was restarted` | `workflow/pipeline.py:336-361` | manual `retry "$RUN"` is documented for post-freeze failures; not asserted by a test | deliberate |
| `Verification retry limit exhausted; work and evidence retained` | `workflow/automatic.py:731-732` | none (edit `attempts.json` by hand, as recorded) | deliberate |
| `<phase>/<node> failed identically on attempts N-1 and N` | `:718-723` | manual `retry --phase --node` if under the cap | deliberate |
| `Interrupted check attempt exists; use an explicitly incremented attempt` | `workflow/checks.py:152-153` | manual `retry --phase --node` | accident (no evidence to protect) |
| `Existing verification belongs to a different revision/policy` | `:147-150` | none | deliberate |
| `Partial candidate worktree exists; inspect before recovery` | `workflow/pipeline.py:486-487` | `git worktree remove` by hand | accident |
| cherry-pick `CalledProcessError` (conflicting lanes) | `:492` | none; new run | deliberate (no automatic conflict resolution, runbook) |
| `Worker evidence no longer passes` | `:480` | none | deliberate |
| `Combined candidate failed <lane> checks` after the cap or an identical repeat | `:504` with `workflow/automatic.py:718-732` | as above | deliberate |
| `Prior reviewer invocation needs reconciliation; no automatic relaunch` (any `blocked` or foreign-transport status; every print failure; Ctrl-C in print mode) | `workflow/automatic.py:399,673-682` | none | deliberate for verdicts, accident for print-mode interruptions |
| `Partial review worktree exists; reconcile rather than overwrite` | `:400-402` | `git worktree remove` by hand | accident |
| `Reviewer <id> needs reconciliation; no automatic relaunch` (launch never issued, or launch raised) | `:421-425,544-549` | none | deliberate (never relaunch), but a never-issued launch is provably safe to issue (Recommendation 5) |
| `Reviewer <id> deadline exhausted; no second reviewer is launched` | `:351-354,650-652` | none | deliberate |
| `Native reviewer <id> missing; reconciliation required` | `:355-357` | none | deliberate wording, same objection as for workers |
| `Invalid review completion file` / `Malformed review completion signal` / `... violates the schema` / `Stale or foreign review completion signal` / `Review finding names worker ...` | `:301-316,181` | none; all reviewers stopped | deliberate |
| `Reviewer identity changed or is not independent (<id>)` | `:565` | none | deliberate |
| `Reviewer worktree changed`, `Evidence changed during review` | `:579-582,668-671` | none | deliberate |
| `Independent reviewer blocked the candidate (<ids>)` | `:487` | none; new run | deliberate |
| `Reviewer <id> did not succeed; inspect retained output` (print) | `:655` | none | deliberate |
| `Unexpected manual gate in automatic run; inspect state` | `:821` | none in automatic mode; the manual commands continue | deliberate |
| `Non-retryable graph failure; inspect retained evidence` | `:823` | depends on the underlying error | catch-all; deliberate |
| `No verified feature-branch completion` (graph finished, `HEAD` or status wrong) | `:790-794` | fix the source checkout and rerun | not permanent |
| `Source feature branch changed; no automatic continuation` | `:780-781` | switch back and rerun | not permanent |
| `Automatic controller restart limit exhausted` | `:752` | rerun `automatic` | not permanent |
| `Approval references stale evidence`, `Source branch changed`, `Source worktree is dirty; refusing integration`, `Integration intent changed`, `Source advanced since preparation` | `workflow/pipeline.py:547-562` | manual `retry "$RUN"` after fixing the source, undocumented for automatic mode | deliberate |
| `Pinned policy changed`, `Plan names lanes the pinned policy does not declare`, `Plan does not account for every declared lane`, `Plan nodes do not match the selected lanes`, malformed `automatic` settings | `:256-259,600-611`, `workflow/automatic.py:43-55` | none | deliberate |
| `Another controller owns this run` | `workflow/sessions.py:148` | wait for the other process | not permanent |

## 10. Ranked recommendations

Ranked by how much operator intervention each removes per run without weakening a boundary; every item names the
file and function it changes and the test that would prove it.

1. **Auto-increment an interrupted verification attempt.** In `workflow/automatic.py:advance_failed_checks`, treat an
   attempt directory without `packet.json` as an interrupted attempt and, within the cap, bump the counter instead of
   returning `False`; `workflow/checks.py:verify_revision` keeps refusing to reuse the directory. Test: a
   `SharedGraphTests` case that kills the step process during `verify_adapter` in a subprocess, then resumes and
   reaches the verified branch with `adapter: [1, 2]` and the worker packet of `ui` unchanged.
2. **Read completion files before enforcing deadlines on resume.** In `wait_handoffs` and `wait_reviews`
   (`workflow/automatic.py:113-141,344-377`), check for an acceptable file first and raise the deadline only when none
   exists. Test: `CompletionTests` and `ReviewCompletionTests` cases where the clock is past the deadline, the session
   is idle and the file binds; the handoff is written and no error raised.
3. **Accept a completion file from a session that exited after writing it.** In `wait_handoffs`, when `locate`
   returns `None` but the completion file validates and the worktree is at `base_commit`, record an `interactive`
   event and accept; `stop_session` already handles an absent session. Test: `CompletionTests` with `locate`
   returning `None` after the file exists, asserting the handoff and the event, plus the existing missing-session
   case still raising when no file exists.
4. **Persist reviewer decisions at acceptance.** In `wait_reviews` call `state.record_decisions()` and `save()` with
   each acceptance, and in `ReviewStatus.load` restore `decisions` from status files. Test: a `NativeReviewerTests`
   case interrupting after the first of two acceptances, removing that reviewer's inventory row, then resuming to an
   approved `review.json` with the original `accepted_at`.
5. **Launch a reviewer whose launch was provably never issued.** In `rebind_reviewers`, when a reviewer has no receipt
   and no launch log, launch it (the receipt is written before the helper runs, `workflow/interactive.py:232`, so
   absence proves no command was issued). Test: change `ParallelReviewerScenarios.test_interrupted_launch` to expect
   `coverage` launched exactly once on resume and the run reaching the verified branch; keep a case where a receipt
   without a row still needs reconciliation.
6. **Make print-transport reviews survive a controller interruption.** In `_review_print`, catch `KeyboardInterrupt`
   separately: leave the jobs running (they already have their own session and output files), persist their PIDs and
   start times in the status files, and on resume wait on those PIDs or read the finished `stdout.json`. Test:
   `PrintReviewerTests` case mirroring `test_interrupted_reviewer_wait_keeps_the_reviewers_and_resumes_in_a_new_process`.
7. **Retry transient inventory failures.** In `wait_handoffs` and `wait_reviews`, catch `subprocess` errors from
   `sessions.inventory()` for a bounded number of consecutive polls (for example five) before treating them as a run
   failure, recording one event. Test: `CompletionTests` with `inventory` raising twice then succeeding; no stop, one
   event, handoffs accepted.
8. **Remove a partial candidate or review worktree that carries no evidence.** In `Pipeline.candidate`, when
   `candidate.json` is absent and `$RUN/candidate` exists, `git worktree remove --force` it and rebuild; in
   `review_candidate`, when `automatic-review.json` is absent and `review-worktree` exists, the same. Both directories
   are controller-made from pinned SHAs. Test: `PipelineTests` seeding a stray candidate worktree without
   `candidate.json`, asserting the candidate is rebuilt and the bundle hashes match a clean run.
9. **Show "needs attention" in the viewer.** In `workflow/export_state.py` derive a `needs_attention` list from the
   latest `interactive` event per lane whose message contains `needs attention`, and in `server/projects.ts:projectSnapshot`
   map it to `awaiting_approval` for that lane's launch node. Test: an `ExportSectionTests` case and a
   `server/projects.test.ts` case seeding the event and asserting the node status.
10. **Merge the worker relaunch from `fix/worker-relaunch` with a rotated token.** `Pipeline.relaunch_worker` as on
    that branch, plus a new `launch_token` written to the plan and prompt so the archived session's file cannot
    satisfy the new attempt. Test: the branch's `test_pipeline` additions, extended to assert that a completion file
    carrying the archived token is refused. This does not weaken a boundary because it launches only after a
    confirmed stop, never reuses a session and keeps every prior file under `relaunched/`.

## Checks executed for this document

The two checks the policy requires were run in this worktree after `npm ci`: `npm run test:contracts` and
`npm run test:unit`. Their results are reported in the completion summary of the run; they prove the worktree is
intact, not any claim above. The Python suite (`python -m unittest discover -s workflow -t .`) was not run for this
audit; every "tested" attribution comes from reading the test source at `13fd687`.

## Open assumptions

- What `claude --safe-mode` restricts, and that `--permission-mode dontAsk` with a single `Edit(//path)` allow rule
  denies every other write: stated in code comments as observed live, not asserted by any test read here.
- That the live `claude agents --json` state vocabulary is exactly `idle|working|blocked|done` (plus terminal states):
  inferred from `locate` and the fixed commit message, not from CLI documentation.
- How LangGraph treats a parallel task killed by `KeyboardInterrupt` (whether the sibling's write is kept) and whether
  a node that raised after consuming an interrupt resume value re-runs with that value on `retry`: not asserted by any
  test; the runbook's "retry resumes failed post-freeze steps" is taken on the runbook's word.
- The mechanism that appended `worker-lanes-001` event 11 and reset the attempt counters in two recorded runs is not
  in the repository history; it is assumed to be manual operator editing.
