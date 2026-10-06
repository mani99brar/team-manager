# MD Manager Workflow — Learnings

Durable, data-grounded learnings about the md-manager workflow pipeline, its review/attack layers, and how to operate and evaluate them. Assembled 2026-10-05 → 2026-10-06. Local only.

**Sources:** the MD Manager Run Ledger (132 pipeline + 87 ultracode runs; artifact `https://claude.ai/artifact/P6EE5JdhdS2feUnstCXHGb`); the attack-pass pilot calibration (`md-manager-reviews/attack-pass-pilot-calibration-report.md`); two multi-provider review experiments (`md-manager-reviews/multi-provider-review-claims-005.md` and `md-manager-reviews/mpreview-batch/RESULTS.md`); and hands-on operation this session.

---

## 1. The numbers so far (Run Ledger, 2026-10-05)

**Pipeline — 132 runs, $2,103 total, mean $15.9/run, 2,291 findings.**
- Outcomes: **44% integrated** (58), ~**36% blocked/paused** (42 review-blocked + 8 other-blocked + 12 paused-at-challenge), 9 stopped mid-run, 3 abandoned.
- **Blocked runs cost MORE than integrated ones** ($18.4 vs $14.7 mean) — you pay nearly full freight and then don't ship. Catching problems *earlier* (challenge) is where the savings are.
- Time sinks (savable wall clock): **operator wait 35.8h (dominant)**, design-challenge-paused 7.9h, Claude outage 3.1h (auto-recovered, no human), idle sidecar $10 over 20 passes.
- **Design challenge pauses 54% of attempts** (128/239) — it is doing a lot of gating work (and generating a lot of operator round-trips).

**Ultracode (Workflow tool) — 87 runs, $2,236 total, mean $25.7/run, 948 findings.** Pricier per run than the pipeline; no challenge/operator-wait/sidecar structure. Mostly md-manager (75).

**Review-replay calibration — 788 samples** (the recall-measurement harness).

---

## 2. Pipeline assessment

**Strengths (earned, visible in the data):**
- **Challenge-first is the highest-leverage stage.** It pauses >half of attempts on real design flaws *before any code is written* — cheapest possible place to catch them.
- **Reproduction-as-evidence runs through everything** (verify re-runs on clean copies; the attack pass re-runs tests on a clean copy; fixes demand red/green). Evidence over assertion is the right spine.
- **Layering + determinism where it belongs:** deterministic policy checks → blocking reviewers → advisory sidecar → report-only attack pass. The reviewers do catch real P1s.
- Production-grade plumbing: resumability, locks, run-scoped model/effort pins, additively-versioned export (1.0→1.8), the viewer.

**Weaknesses (the important one first):**
- **The LLM-judgment layers share correlated blind spots.** The architecture looks like independent coverage (reviewers, sidecar, attacker, skeptic) but they're all the same kind of judge and fail the same way — prompt-sensitivity and scope-conservatism. Evidence: pine's security review caught claims-005's provenance P1 in only 0–2 of 3 samples by prompt wording; the attack pass missed it entirely; the skeptic over-refuted real findings on scope. **Stacking more LLM judges doesn't buy independence when they correlate.** (Multi-provider decorrelation is the fix — §4.)
- **Operational fragility:** Claude reinstall churn killing sessions, the safeguard model-switch dialog, OOM risk, non-obvious footguns (§6). Much is incidental environment churn, but it raises the cost to operate.
- **"Reviewed == merged" is rigid:** an operator fixing a finding directly must bypass the pipeline (hand-landed after an independent review), because reviewers never see a direct fix.

---

## 3. Attack pass (red team) — pilot calibration

Two calibration runs on the claims-005 candidate (known bug: SEC-GH-11, forged GitHub provenance marked `verified` because `integrity.ts`/`evaluateClaim` checks on-chain field match but never membership). Full report in `attack-pass-pilot-calibration-report.md`.

- **Run 1 (ambient effort):** 4 findings, all reproduced, **skeptic refuted all 4 on scope → 0 verified**; missed SEC-GH-11. Two of the 4 (SEC-GH-12/13 publish rechecks) were real and the human review also found them.
- **Run 2 (Opus 4.8, max effort + tuned skeptic):** **0 findings** — the stronger attacker **actively cleared SEC-GH-11 as "fine"** (it only checked the Pine preview path, missing the direct-on-chain-registration path). More effort made it *worse*.
- **Lessons:** keep effort modest (recall was better at default); the limiter is **scope/lane framing** in both the attacker and skeptic briefs (they defer cross-cutting requirements to "other lanes" and treat the project's own requirements doc as superseded), not model size. Keep it **report-only**; don't promote to blocking; validate brief changes on a *different* known bug (not fit-to-test).

---

## 4. Multi-provider review — the bigger lever

**Single-run (claims-005).** Given the identical material, **Claude in plain review mode FOUND SEC-GH-11** (P0) that the Claude-based *attack pass* missed at both effort levels. Same model family, different method, opposite result → **the limiter is the method + scope framing, not model capability.**

**5-run batch (hardening/chain runs, 3 providers each).** Scored against each pipeline verdict:
- **The panel surfaced security/correctness issues the pipeline's own reviewers did not** — on 4/5 runs, including both runs the pipeline *approved*. (The pipeline blocked 3/5 on **coverage**, not security; its security reviewer approved them.)
- **Providers decorrelate:** DeepSeek caught concrete *code bugs*; GPT caught *concurrency races*; Claude caught *systemic/defense-in-depth* issues (and confirmed a positive — the SEC-GH-12 repojack gap is now fixed at publish).
- **Cross-provider overlap is the highest-confidence signal:** all three independently flagged the same "`mined` from non-final evidence → a reorg strands it forever" dependency.
- **Verification caveat (the key cautionary tale):** of DeepSeek's two sharpest cl-002 findings, one (`randomUUID()` reused per row → duplicate PK) is a **real but latent** footgun (current callers are all single-row, so it can't fire today), and the other (`succeeded` "Set used as boolean") is a **false positive from chunk context-loss** — the chunk showed the usage change without the paired definition change. So: multi-provider breadth is genuinely valuable, but findings need code-verification, and degraded context manufactures false positives.

**Net lesson:** multi-provider *review* decorrelates the blind spots §2 identified. The single-provider attack pass is the weaker lens for provenance/logic bugs. A review panel across providers + the overlap signal is the stronger tool.

---

## 5. The `pi` multi-provider transport — hard limits (operational)

`pi -p` (the CLI that reaches OpenAI/DeepSeek) **works only for small prose prompts** (its original idea-review use: returns in seconds). For code review it is **unsuitable as-is**:
- **Code fences hang it:** a 6 KB ```` ``` ````-fenced diff returns 0 bytes after 15 min; the same content **without fences** returns.
- **Size cliff:** anything past ~8–10 KB hangs to 0 output (both GPT and DeepSeek, `@file` and stdin, both models), while equivalent small prose works.
- **Concurrency:** ~40% of chunks time out when 6 run at once.
- Workaround used: source-only diff, **no fences, 7 KB chunks** → ~60% delivery, no cross-file context, and context-loss false positives (§4).

**Implication:** a `pi -p` transport could **not** be bolted onto md-manager's reviewers/attackers for real diffs without fixing this. For GPT/DeepSeek code review, call their native APIs with proper structured payloads, not the `pi -p` prompt path. (Claude via a Code subagent has no such limit — full diff + requirements, reliably.)

---

## 6. Operational gotchas (hard-won this session)

- **Attacker/skeptic effort is the JUDGE role, not `WORKFLOW_WORKER_EFFORT`.** The attack pass's attacker and skeptic both read `plan.roles.judges` pins; `WORKFLOW_WORKER_EFFORT` only affects workers. To max the attacker, set `plan.roles.judges = {model, effort: max}` (a plan with `roles: null` runs at Claude Code's ambient default — no pins).
- **`attack_check` test collection:** the attacker's tests must land where the project's test runner collects them. For pine, that's `packages/api/src/**/attack-tests/` (a repo-root `attack-tests/` is **not** collected by any package's vitest `include`). The attacker brief must say exactly where to write. `attack_check = pnpm --filter @pine/api exec vitest run {file}`.
- **Candidate reconstruction:** a finished run's candidate commit and worktree get removed/GC'd. Reconstruct from `plan.base_commit` + the run's stored `review.diff`: check the base out in `~/dev/pine`, apply the diff, commit, and **tag** it so gc won't drop it.
- **Surfacing any run dir in the viewer:** generate a `run-state.json` with `export_state(runtime, state)` using a tiny fake `runtime` (`.directory/.plan/.policy`) + empty `state` (`tasks=[]/values={}/next=[]`). Drop the dir under a project's `runs_root` and it lists (needs `langgraph` → use the venv python).
- **Detached launches:** `!`-prefixed `nohup … &` dies when the turn's process group is torn down. Use **tmux** (its server daemon survives) and the **venv python** (`.venv/bin/python` — bare `python` lacks `langgraph`).
- **The launch is gated from the assistant:** spawning the attacker (`claude --print` with Bash + `bypassPermissions`) is refused by the auto-mode classifier ("Create Unsafe Agents"). The operator launches it (tmux) or adds a Bash permission rule.
- **Sandbox live-probe:** one `claude --print` with the worker `--settings` confirms the sandbox — Edit/Write/Bash run while a Read of a credential path is denied (26 deny-rules).
- **Claude outages auto-recover:** `claude agents --json` timeouts are frequent (3.1h across 132 runs) but the supervisor resumes without a human.
- **OOM:** PGlite is ~400 MB per test *file*; cap concurrent heavy agents (the box has OOM'd before; keep ~3 Opus subagents max alongside the service).

---

## 7. Evaluation methodology

- **Don't fit-to-test.** Changing a brief toward a known answer and rerunning on the same bug measures nothing. Change effort/model/skeptic freely (not the attacker's brief), and validate brief changes on a *different* known bug.
- **Isolate the component under test.** To test a skeptic change, re-judge existing reproduced findings through the tuned skeptic — don't rerun the attacker.
- **Code-confirm findings; trust cross-provider overlap most.** A finding three providers independently raise is the one to verify first. A single provider's sharp-looking finding can be a context-loss artifact.
- **Pipeline "blocked" ≠ "security problem."** Most hardening-run blocks were **coverage** P1s ("every item needs a failing test"), with the security reviewer approving. Coverage and security are separate axes; read the block reason.
- **Claude usage is not treated as out-of-pocket cost** (operator rule) — don't gate work on it; real-money caution is for gas, funded wallets, and paid third-party services.

---

## 8. Where the evidence lives
- Run Ledger artifact: `https://claude.ai/artifact/P6EE5JdhdS2feUnstCXHGb`
- Attack-pass calibration: `md-manager-reviews/attack-pass-pilot-calibration-report.md` (+ `attack-pass-calibration-001.md`)
- Multi-provider: `md-manager-reviews/multi-provider-review-claims-005.md`; `md-manager-reviews/mpreview-batch/RESULTS.md` (+ prompt, per-run outputs, `pi_orchestrator.py`)
- Memory: `attack-pass-prd.md`, `claude-cost-not-real-money.md`
