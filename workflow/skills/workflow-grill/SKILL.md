---
name: workflow-grill
description: Interview the operator before a workflow feature launch and write features/<feature>/decisions.md. Use when the user runs /workflow-grill <feature>, or asks to grill, interview or settle the decisions of a workflow feature before `python -m workflow launch`. Asks at most five questions, one at a time, each with a recommended default and its consequence; never writes code.
argument-hint: <feature> [--repo <target repository>]
allowed-tools: Read, Glob, Grep, Write, Edit
---

# Workflow grill: settle a feature's decisions before launch

You interview the operator about the one feature named in the argument, then write its `decisions.md`. A `feature.json` 2.2.0 feature cannot launch without a non-empty `decisions.md`, and every worker and reviewer prompt of the run includes it after the task, so what you write binds the whole run.

## 1. Read before asking

- The target repository is the `--repo` argument, else the current Git repository. The feature lives at `<target>/features/<feature>/`; stop and say so if it has no `feature.json`.
- Read `feature.json`, the PRD it names in `prd` (relative to the target; it may be a PDF), every lane task file it lists, `policy.json` (owned paths and checks per lane) and an existing `decisions.md`, if any. Read the code only as far as a question needs it.
- List for yourself the uncertainties that could change the design or the acceptance: contradictions between the PRD and the tasks, lanes whose owned paths or responsibilities overlap, acceptance that no check can prove, an unbounded `## Stop`, choices the PRD leaves open. Drop anything the documents already settle, and anything a worker can decide alone without changing the outcome.

## 2. Ask at most five questions, one at a time

- Rank the uncertainties by how much a wrong guess would cost and ask about the top ones only: never more than five questions in total.
- Ask exactly one question per message and wait for the answer before the next one.
- Every question states the recommended default and its consequence, in this shape:

  > **Question 2 of at most 5:** Should the adapter lane own `contracts/`, or should both lanes share it?
  > **Recommended:** the adapter lane owns it. **Consequence:** the ui lane builds against the adapter's shape and cannot change it; a shape change needs a new run.
  > Other options: both share it (ownership check cannot separate them; conflicts at the candidate).

- Accept a short answer ("yes", "the default", "B"). If an answer opens a new, more important uncertainty, it may replace a lower-ranked question; the limit stays five.
- After the fifth answer, ask nothing more. Resolve what is still open yourself with its recommended default (record it under `## Assumptions`), or move it to `## Deferred` when it does not block this feature.

## 3. Write `features/<feature>/decisions.md`

Write the file (replace a scaffold placeholder or an older version; show the operator the result) with exactly these three sections, short and concrete, one bullet per item:

```markdown
# Decisions: <feature>

From the grill session of <date> with the operator.

## Decisions

- <what was decided>: <its consequence for the lanes or the acceptance>.

## Assumptions

- <what the lanes may assume without asking, including defaults you chose after the fifth question>.

## Deferred

- <what this feature explicitly leaves for later>, or "Nothing".
```

- No `TODO:` line may remain: launch refuses a feature whose `decisions.md` still has one.
- Quote file paths, check ids and lane ids exactly as the feature files spell them.
- Do not edit the tasks, the policy, the PRD or any code. If an answer means a task must change, say which file and what to change, and leave the edit to the operator.

## 4. Hand back

End with the path of `decisions.md` and the next commands:

```bash
python -m workflow launch <feature> --repo <target> --dry-run
python -m workflow launch <feature> --repo <target> --live --automatic
```

The design challenge then reads the PRD, the tasks and this file before any worker starts.
