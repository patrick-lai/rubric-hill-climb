# rubric-hill-climb

A skill for iterating on work against a scored rubric without drifting or looping forever.

It fixes two problems with "hill climb this until it is 8/10":

- **No standard.** The rubric (weighted criteria, anchored 0 to 10 scales, evidence, gates, target, budget) is written once, before iteration 1, and is frozen for the run. The baseline is scored with it, and every attempt follows the same six steps.
- **Back and forth near 8/10.** An attempt is kept only if it beats the best score by more than the measured noise and no earlier win drops by more than 0.5. Anything else is reverted, so the working tree only moves up. Feedback is mapped to a criterion and applied one focus at a time.

It also decides when to stop: success, budget, plateau (2 reverted attempts in a row), conflict (the same criterion broken twice), capped criteria and diminishing returns (the projected remaining gain cannot reach the target).

## Install

```sh
npx skills add patrick-lai/rubric-hill-climb --skill rubric-hill-climb --global --yes
```

CommissionAI ships the same text as its `commissionai-hill-climb` topic skill.

## Mechanical decisions

`scripts/decide.mjs` replays a ledger against a rubric and prints the verdict, so keep, revert and stop do not depend on how the agent feels.

```sh
node scripts/decide.mjs rubric.json ledger.jsonl
```

```json
{"target": 8, "max_iterations": 6, "criteria": [{"id": "correct", "weight": 3}, {"id": "robust", "weight": 2}, {"id": "polish", "weight": 1}]}
```

```jsonl
{"iter":0,"scores":{"correct":6,"robust":6,"polish":6}}
{"iter":1,"focus":"correct","scores":{"correct":7,"robust":7,"polish":6},"spread":0.2,"gates":true}
{"iter":2,"focus":"robust","scores":{"correct":7.3,"robust":7.2,"polish":6.5},"spread":0.2,"gates":true}
```

That ledger stops with `diminishing_returns`: the totals go 6.0, 6.83, 7.13; the last gain (0.3) is about a third of the one before, so at most 0.17 more is reachable and 7.3 stays under 8.

Defaults: target 8, 6 attempts, minimum gain 0.25, regression tolerance 0.5, patience 2, floor target minus 1.5.

## Develop

```sh
node --test
```

MIT. See `LICENSE`.
