---
name: rubric-hill-climb
description: Use when asked to hill climb, iterate until a score like 8/10, keep improving work against feedback, or repeat review, critique or fix rounds until approved. Freezes a scored rubric, runs identical iterations that keep only measured gains, guards against regressions and flip-flopping, and stops on success, budget, plateau or diminishing returns.
---

# Rubric hill climbing

Use this when asked to "hill climb", polish, iterate until it scores N/10, keep improving something against feedback, or repeat review, critique or fix rounds until a reviewer approves. It makes every iteration the same, keeps only changes that measurably help, and says when to stop. Two failures it prevents: a different standard each run, and flip-flopping near 8/10 because each fix breaks something already fixed.

## 1. Freeze the rubric before iteration 1

Quality is whatever the rubric says. Write it once, show it in a short table, then do not edit it during the run.

- **Target**: the score the user named (default 8/10). **Budget**: 6 attempts (hard cap 10). Both are part of the rubric.
- **4 to 7 criteria**, each with a weight, a 0 to 10 scale and anchors for 2, 5, 8 and 10 that describe what you would observe ("8: every listed state renders, no console errors, matches neighbouring screens"). A criterion you cannot anchor is a wish: drop it or split it.
- **Evidence** per criterion: the exact command, test, screenshot or file to inspect. Prefer checks a machine decides (test, lint, exit code, measured number), then a fixed-label question to a classifier, and a fresh-context judge only for open-ended quality.
- **Gates** are pass/fail, never scored: tests pass, build is green, nothing outside scope changed. A failed gate rejects the attempt whatever the score.
- 8 means every stated requirement is met and a careful reviewer finds nothing they would flag. 10 means nothing a user would notice is left. Do not set a target of 10.
- Vague prompt ("make this better")? Derive the rubric from the request, state the criteria in one line each and start. Ask once only when the answer changes what "better" means. Only the user changes a rubric; a changed rubric is a new run with a new baseline.

Save `rubric.json` and `ledger.jsonl` under `.commission/hill-climb/NAME/` (never committed):

```json
{"target": 8, "max_iterations": 6, "min_gain": 0.25, "regression_tolerance": 0.5, "patience": 2,
 "criteria": [{"id": "correct", "weight": 3}, {"id": "robust", "weight": 2}, {"id": "polish", "weight": 1}]}
```

Total is the weighted mean. `floor` defaults to target minus 1.5: success needs the total at target and no criterion under the floor, so a strong average cannot hide a weak part.

## 2. Score the baseline

Score the untouched work with the rubric first (iteration 0). The baseline is the number every later attempt must beat.

**Grader rules** (the same for every score in the run):
- The author never scores its own work. Every score uses a fresh context. Do not keep one judge alive across iterations: it anchors on its own earlier numbers, roots for changes it watched, and after compaction it is a new judge that still remembers old scores.
- What keeps fresh judges consistent is a **calibration pack**, written once after the baseline and frozen with the rubric: the rubric with its anchors, the baseline artifact, and its baseline scores with their evidence notes. Every judge gets the pack, so one judge's 7 means what the last one's did. It never sees later scores, feedback or what changed. Save it beside the rubric as `calibration.md`.
- Same grader model, same prompt, same evidence method all run. Changing the grader makes scores incomparable.
- 3 independent samples; take the median per criterion in 0.5 steps, with a one-line evidence note each. `spread` is the largest minus smallest sample total. Deterministic checks need one sample.
- A score below 8 must name the defect (file and line, screenshot, failing check). No named defect, no deduction.

## 3. Every iteration runs these steps, in order

1. **Pick one focus**: the criterion with the largest weight times gap to target, skipping capped criteria. One focus per attempt; feedback on other criteria waits.
2. **Make the smallest change that moves that criterion**, then checkpoint it (commit or snapshot) so it can be undone.
3. **Compare with the best kept version, then re-score every criterion**, not only the focus. Regressions hide in the criteria you were not looking at. Each judge gets the calibration pack and both versions labelled X and Y, in a random order per sample, never called old or new. For every criterion it says whether Y is better, the same or worse than X and names the defect that differs; no named defect means the same. The majority of 3 samples goes in `vs_best` (no majority means the same). A machine-decided criterion takes its verdict from the two measurements. The judge also scores the attempt on the anchored scale.
4. **Decide keep or revert** (rules below). A reverted attempt is undone in the tree, so the tree always holds the best kept version.
5. **Append one ledger line**: `{"iter":3,"focus":"robust","scores":{"correct":8,"robust":7.5,"polish":7},"vs_best":{"correct":"same","robust":"better","polish":"same"},"spread":0.3,"gates":true,"change":"retry on timeout"}`. The first line is iteration 0 with the baseline scores and no focus.
6. **Check the stop rules.** Stop, or go to step 1.

### Keep or revert

Keep only when all hold:
- gates pass;
- the focus criterion is judged better than the best kept version;
- no criterion is judged worse. Those comparisons are the locks: a win stays won.

A kept score moves only for a criterion judged better, and only up; a criterion judged the same keeps its kept score. So a number that bounces while the work stays the same never moves the run. A fix that improves the focus but is judged worse elsewhere is reverted and noted as a trade-off.

When no side-by-side comparison is possible (the best kept version cannot be shown again), leave `vs_best` out and fall back to the scores: keep only when the total beats the best kept total by at least `max(min_gain, spread)` (default 0.25) and no criterion fell more than `regression_tolerance` (0.5) below its best kept score.

### Handling feedback

- Map each piece of feedback to a criterion. Act on it only through the focus step. Feedback that maps to no criterion goes in an `unanchored` list and is reported, not implemented. If it is really a missing requirement, tell the user it needs a new rubric.
- Feedback that asks to undo a kept change is a conflict, not an instruction. Look in the ledger for why it was kept, do not toggle, and report which two criteria disagree.
- Never apply all feedback at once. One focus per attempt is what lets you tell which change helped.

## 4. When to stop

Check after every attempt, in this order. The first match ends the run.

| Stop | When | Then |
| --- | --- | --- |
| success | total at least target and every criterion at least the floor, gates pass | ship the kept version |
| conflict | two attempts were reverted for making the same criterion worse | criteria trade off; ask the user |
| budget | attempts used equal the budget | ship the best kept version |
| plateau | `patience` (2) attempts in a row were reverted | more tries are not helping |
| diminishing returns | best total plus the reachable remainder is still under target | target is out of reach, stop early |
| capped | every short criterion was tried twice with no kept gain | nothing left to try |

**Diminishing returns** means the gains are shrinking faster than the distance to the target. With `g` the last kept gain, `r = g / previous gain` and `remaining` the unused attempts, the reachable remainder is `g * remaining` if gains are not shrinking, or `min(g * remaining, g * r / (1 - r))` if they are (the sum of a geometric tail). If best plus that remainder is under the target, stop now rather than spend the rest of the budget. Example: 6.0 to 7.0 to 7.3 gives `g = 0.3`, `r = 0.3`, a tail of about 0.13, so 7.4 at best against a target of 8: stop at 7.3.

A criterion tried twice with no kept gain is capped: move to the next one. Scores from 8 up rise slowly and carry the most noise, so expect few kept gains there. That is the rule working, not a reason to loosen it. Never raise the budget, lower the bar or extend a run to reach the target; on stop, hand the decision to the user.

## 5. Report

End with the outcome first: the stop reason and the kept total against the target. Then a table of baseline, best and target per criterion; the trajectory of kept totals; reverted attempts with the reason; unanchored feedback; and, if the target was missed, the named defects that block it. Offer concrete next steps: accept the best version, lower the target, change the rubric (new run), or give more budget.

## Optional: apply the rules mechanically

`scripts/decide.mjs RUBRIC.json LEDGER.jsonl` replays the ledger and prints the verdict for the latest attempt (kept or reverted and why), the locks, capped criteria, the next focus and whether to stop. Run it after each scoring instead of judging by feel. It needs only Node 18 or newer.
