# Handoff: the operator-override acceptance in the engine (lane `engine`, run accept-override-001)

Spec: [PRD_ACCEPT_OVERRIDE.md](../PRD_ACCEPT_OVERRIDE.md); decisions `features/accept-override/decisions.md`
(O1–O4, G1–G6, L1–L13, design notes 1–7). This is the contract the viewer lane follows for the export key and its fields.

## The export key the viewer reads

`run-state.json` is **export 1.12.0** (`EXPORT_VERSION = "1.12.0"`, [L1]). It carries one new **top-level key `accepted`**:

- `null` for every run that was not accepted (every run prepared before this feature exports byte-for-byte as under 1.11.0
  apart from the version and this null key);
- otherwise the contents of `<run>/accepted.json` **verbatim** — the same object, no added or dropped key.

The record is validated against `contracts/workflow/accepted.schema.json` at export time. A present-but-invalid
`accepted.json` **fails the export**, with a message naming the file (design note 7); the viewer keeps its strict parse, so a
corrupt override never hides the run silently.

### Exact shape of `accepted` (and of `<run>/accepted.json`), one literal for both lanes ([L8])

```jsonc
{
  "version": "1.0.0",            // const
  "run_id": "shared-memory-006", // non-empty string
  "candidate": "89b10…",         // 40-hex; the run's own candidate commit (brief.candidate_commit)
  "reason": "merged by hand …",  // non-empty string
  "by": "operator",              // const "operator" (accept is operator-only)
  "via": "claude-code",          // OPTIONAL: present only when the command ran from a Claude Code session
  "accepted_at": "2026-10-08T12:00:00Z", // UTC ISO date-time ending in "Z" (what checks.now() writes); schema `pattern` enforces it
  "on_main": true,               // boolean: is the candidate an ancestor of the target's main/master/base branch
  "review": "recorded",          // "recorded" when the run has a review.json, else "none"
  "open_findings": [             // the findings open at acceptance ([L5]); [] when review is "none"
    { "severity": "P1",          // "P0" | "P1" | "P2"
      "reviewer": "coverage",    // non-empty string
      "title": "a fail-safe is untested.", // the review finding's `message`, verbatim
      "lane": "engine" }         // the finding's `worker` when that is a lane id, else null
  ]
}
```

No other key. The viewer parses exactly this set (`z.strictObject`, `via` optional) and nothing else ([L8], [L13](a)).

- **`accepted_at` ([L8], [L14]).** A UTC ISO date-time ending in `Z` — exactly what `checks.now()` writes. The schema pins it
  with `pattern` `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$` (and `format: "date-time"`), so a hand-edited non-ISO value
  fails `validate_schema("accepted", …)` and therefore the export, the way the viewer's strict `z.iso.datetime()` would — the
  two lanes no longer disagree, and a hand-fixed record cannot pass `workflow export` yet make the run RUN_STORAGE_INVALID.

- **`open_findings` rule ([L5]).** The blocking findings first — every P0/P1 whose disposition is not `resolved` (accepted
  ones included, as `pipeline.blocking_findings`) — then the P2s whose disposition is `open` (as `outcome.py`). `title` is the
  finding's `message` verbatim; `lane` is its `worker` only when that is one of the run's lane ids, else `null` (so `multiple`
  and `none` become `null`).
- **`review: "none"` ([L4], design note 4).** When the run has no `review.json`, `review` is `"none"` and `open_findings` is
  `[]`. The viewer must read `review` first and show **"no review recorded"** for `"none"`, not "no open findings at
  acceptance" (that text is for `"recorded"` with an empty list). The engine's own outcome block does the same.
- **`on_main` ([O4], [G2]).** `accept` checks whether the candidate is an ancestor of the target's `main`, else `master`, else
  the branch `prepare` recorded as the base (`plan.source_branch`); it never fetches. When it is not, the override is still
  recorded with `on_main: false` and the command prints a warning.
- The engine's example records, validated by `contracts/workflow/contract.test.ts`, are
  `contracts/workflow/examples/accepted.example.json` (findings + `via`, `review: "recorded"`) and
  `accepted.unreviewed.example.json` (`review: "none"`, no `via`, empty findings). The viewer's candidate-phase test parses
  `contracts/workflow/examples/accepted*.json` with its own schema ([L13](a)).

## What else the engine ships (for the viewer's own sites, not its export contract)

- **`accept` command** (`workflow/accept.py`, wired in `__main__.py`): `python -m workflow accept <run> --candidate <sha>
  --reason "<text>" --by operator`. Operator-only (`accept` joined `actor.OPERATOR_ONLY`, [L13](c)). Takes the supervisor and
  controller locks as `abandon` does; refuses while a controller holds either, while a recorded session is still live (naming
  it; abandon first, then accept, [L13](e)), on a second accept (its own message), on a run that integrated normally, on a run
  with no candidate, and on a `--candidate` that is not the run's own. `--candidate` is resolved with `git rev-parse` first, so
  a short prefix is accepted and the full sha is stored (design note 5). Accept may follow abandon ([O3]); `abandon` refuses an
  accepted run with its own message ([L13](b)). It writes one `controller` event, status `succeeded`, `Accepted by the operator:
  <reason>` ([G3]); the viewer's `CONTROLLER_PROCESS_ROWS` should match `/^Accepted by the (?:operator|maintainer)\b/`
  ([L13](d)). It resolves every `review_blocked`/`controller_blocked` attention state (whatever the node) and writes no new
  attention record ([G3], [L11]).
- **Outcome block** (`workflow/outcome.py`): an accepted run's outcome is `integrated (operator override): <reason>`, then the
  open findings (or "no review recorded", or "no open findings at acceptance"). It wins even when the run was abandoned first.
- **`status`** (`workflow/pipeline.py`): `status["accepted"]` carries `reason`, `by`, `on_main`, `review`, `open_findings`,
  `accepted_at`; the `next_step` is the accepted run's own ("none: … accepted by the operator …; … For a follow-up: …"),
  checked before the abandoned step, so it never suggests a command that the run then refuses (design note 3).
- **Ledger** (`workflow/ledger.py`): a run with `accepted.json` is an `accepted` run, built from that record's `candidate` and
  `plan.json`'s `base_commit` whatever `review.json` says ([L4]); `accepted` joined `CLASSES`. An accepted candidate is
  classified `accepted` directly and through a merge, wins over `reviewed`/`blocked`, anchors `base_unreviewed` as an approved
  candidate does, and so is no longer listed as unreviewed ([L2], [L9], [G5]). `label()` prints `accepted (override) by run
  <id>`. `base_unreviewed` now also carries `since_class` (`"accepted"` | `"reviewed"` | `null`) so `describe()` names an
  accepted anchor with its run id and the word "override" (never "approved run") in all three branches; `workflow ledger`
  prints the `accepted (override)` count and then one line per accepted run — `  accepted (override) by run <id>: <n>
  commit(s), candidate <sha12>` — so the override is visible with its run id ([G5], [L13](c), [L14]).
- Every mutating command (`approve`, `automatic`, `start`, `retry`, `reconcile`, `repair`, `answer`, `note`, `sidecar-pass`,
  `tryout`, `attack-pass`, …) refuses an accepted run via `accept.refuse_accepted`, as it refuses an abandoned one ([L6]).
  (`attack-pass` arrived on main after 002, so the restore added its guard before the locks — run 003 design note 2.)

## Open assumptions / deviations

None from another lane's reads. The viewer owns the run-status enum (unchanged in `contracts/workflow/v1.ts`, [L12]); the
override travels only in the export's `accepted` key, which the viewer maps onto its own `accepted` field on RunSummary/RunDetail.

Run accept-override-002 widens [L14]'s live-session fold (design challenge note 1, inside this lane): `accept.live_nodes`
treats as not live — and lists no session for — every node abandon named in `abandon.json`'s `stopped`/`not_running`, and
every node the run itself confirmed stopped (`<node>.stop.json` with `stopped: true`, what `Pipeline.stop_workers`/
`stop_reviewer` write on a review block). The listing (`runtime.sessions.inventory()`) is taken lazily, only when a node past
those confirmed-stop checks still might run, as `abandon.rows()` does — so accept records even while `claude agents` is down
whenever every recorded node is already confirmed stopped, whether or not the run was abandoned. This covers the review's
case (1): a review-blocked run that was never abandoned (no `abandon.json`), the PRD's main case, is no longer forced to
abandon first or wait for `claude agents`. This changes no file another lane reads.
