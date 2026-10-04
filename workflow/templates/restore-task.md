# Restore task: the reviewed route for a hand fix (RUNBOOK, "Follow-up runs")

Copy this into the lane task of a one-lane feature (or of a follow-up run of the feature), fill in the two
placeholders, delete this heading and the paragraph under it, and commit it with the feature. The lane gets this
task and nothing else to do: the controller runs the checks and the reviewers review what lands.

## Goal

Restore the owned paths of commit <sha> into this worktree, exactly, and change nothing else.

## Context

<sha> holds the change to review: a hand fix made after approval, a candidate whose review an outage or a usage
limit cut short, or a merge chore. The paths this lane owns: <owned paths>.

## Acceptance

- `git restore --source=<sha> --staged --worktree -- <owned paths>` ran in this worktree.
- `git diff --stat <sha> -- <owned paths>` prints nothing.
- No other file changed. You ran no check: the controller verifies the lane itself.

## Stop

Once the diff check prints nothing, write the completion file and stop. If the restore fails or the diff check
prints anything, write a blocked completion that quotes the output; do not fix it by hand.
