---
name: workflow-grill
description: Interview the operator before a workflow feature launch and write features/<feature>/decisions.md. Use when the user runs /workflow-grill <feature>, or asks to grill, interview or settle the decisions of a workflow feature before `python -m workflow launch`. Asks at most five questions, one at a time, each with a recommended default and its consequence, then reads back every bullet the operator did not choose before any launch; never writes code.
argument-hint: <feature> [--repo <target repository>]
allowed-tools: Read, Glob, Grep, Write, Edit
---

# Workflow grill: settle a feature's decisions before launch

You interview the operator about the one feature named in the argument, then write its `decisions.md`. A `feature.json` 2.2.0 or 2.3.0 feature cannot launch without a non-empty `decisions.md`, and every worker and reviewer prompt of the run includes it after the task. Only the operator's answers bind the run: the `## Operator decisions` you record win over the task, while your own defaults stay open to the design challenge, and a worker may depart from one when the code shows it cannot hold.

## 1. Read before asking

- The target repository is the `--repo` argument, else the current Git repository. The feature lives at `<target>/features/<feature>/`; stop and say so if it has no `feature.json`.
- Read the target's `CLAUDE.md`, `feature.json`, the PRD it names in `prd` (relative to the target; it may be a PDF), every lane task file it lists, `policy.json` (owned paths and checks per lane) and an existing `decisions.md`, if any. Read the code only as far as a question needs it.
- List for yourself the uncertainties that could change the design or the acceptance: contradictions between the PRD and the tasks, lanes whose owned paths or responsibilities overlap, acceptance that no check can prove, an unbounded `## Stop`, choices the PRD leaves open, and values the drafts or your defaults keep by hand that the repository already records (ids, routes, address lists; cite the file that records them). Drop anything the documents already settle, and anything a worker can decide alone without changing the outcome.
- A limit on what the feature delivers (only, never, except, excluded, deferred), one that excludes data or behaviour, never counts as settled by the documents, even when it quotes the operator's own words. Ownership lines are not limits. If there are any limits, Question 1 plays them all back in one question: "You wrote X; the drafts read it as Y, so Z is excluded. Correct?"

## 2. Ask at most five questions, one at a time

- Rank the uncertainties by how much a wrong guess would cost and ask about the top ones only: never more than five questions in total.
- Ask exactly one question per message and wait for the answer before the next one.
- Every question states the recommended default and its consequence, in this shape:

  > **Question 2 of at most 5:** Should the adapter lane own `contracts/`, or should both lanes share it?
  > **Recommended:** the adapter lane owns it. **Consequence:** the ui lane builds against the adapter's shape and cannot change it; a shape change needs a new run.
  > Other options: both share it (ownership check cannot separate them; conflicts at the candidate).

- Options differ only on the dimension the question asks. The `decisions.md` bullet an answer writes commits to nothing its option did not state (the plain-text line, or an AskUserQuestion option's label and description). Anything else a Recommended option would commit to (an interface, a data shape or field, a rule about another file, a scope change) becomes its own question, or a Grill default tagged `[added, not asked]`.
- When the drafts keep a table, a list or a generator by hand, offer the repository's own mechanism for the analogous artifact as an option, citing its file. A reason that exists only because of the workflow run (a fresh worktree, no build, no network) is a run limit, not a product reason: label it as a run limit and name the setup that would lift it.
- Accept a short answer ("yes", "the default", "B"). When the operator answers in their own words, restate the answer in one sentence at the start of your next message, so a misreading can be corrected. If an answer opens a new, more important uncertainty, it may replace a lower-ranked question; the limit stays five.
- A delegation ("you decide") reaches only as far as the operator said: record it as a Grill default that names the items it covers, and apply it to nothing else.
- A question asked but not answered, including a "clarify" reply that was never settled, stays open: write it as `TODO: Q<n> <question>` under `## Operator decisions`. Launch refuses the feature until the operator answers it.
- After the fifth answer, ask nothing more. Resolve what is still open yourself with its recommended default (a Grill default), or move it to `## Deferred` when it does not block this feature.

## 3. Write `features/<feature>/decisions.md`

Write the file (replace a scaffold placeholder or an older version) with exactly these four sections, short and concrete, one bullet per item:

```markdown
# Decisions: <feature>

From the grill session of <date> with the operator.

## Operator decisions

- [O1] Q1: <the chosen option's text>. Operator: "<the operator's words, verbatim>".

## Grill defaults

- [G1] <a default you chose, a delegation with the items it covers, or a rider tagged [added, not asked]>.

## Changes after launch

None yet.

## Deferred

- <what this feature explicitly leaves for later>, or "Nothing".
```

- `## Operator decisions` holds only the operator's answers. Each `[O<n>]` records its question number, the chosen option's text and the operator's words verbatim; an answer given after the grill carries its date or run id instead of a question number. Never edit one in place: a later reading or change is a new bullet that cites the id it changes.
- `## Grill defaults` holds everything you chose, as `[G<n>]`: what the lanes may assume without asking, defaults after the fifth question, delegations with the items they cover and riders tagged `[added, not asked]`.
- `## Changes after launch` holds `[L<n>]` items, each with the run id and attempt; before any run it says "None yet".
- An existing file keeps its Operator decisions as they are; number new bullets after them. A bullet of an older file that you cannot trace to an operator's answer becomes a Grill default.
- The only line that may begin with `TODO:` is an unanswered question, and launch refuses the feature while one remains.
- Quote file paths, check ids and lane ids exactly as the feature files spell them.
- Do not edit the tasks, the policy, the PRD or any code. If an answer means a task must change, say which file and what to change, and leave the edit to the operator.

## 4. Read back, then hand back

Always read back before the hand-back, also when the operator asked up front to grill and launch. Send one message that lists in full every bullet the operator did not choose (every Grill default, `[added, not asked]` riders included, every Deferred bullet and any `TODO:` line), then each Operator decision on one line. End it with one short question: confirm, or say what to change. Change `decisions.md` as the answer says before you hand back.

Then end with the path of `decisions.md` and the next commands; while a `TODO: Q<n>` line remains, say that launch refuses the feature until it is answered:

```bash
python -m workflow launch <feature> --repo <target> --dry-run
python -m workflow launch <feature> --repo <target> --live --automatic
```

The design challenge then reads the PRD, the tasks and this file before any worker starts.
