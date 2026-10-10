import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, InputError, parseLedger } from "../scripts/decide.mjs";

const rubric = (extra = {}) => ({
  target: 8,
  max_iterations: 6,
  criteria: [
    { id: "correct", weight: 3 },
    { id: "robust", weight: 2 },
    { id: "polish", weight: 1 },
  ],
  ...extra,
});

const record = (iter, scores, extra = {}) => ({ iter, focus: iter === 0 ? undefined : "polish", scores, ...extra });
const run = (records, extra) => decide(rubric(extra), records);

test("the baseline alone continues on the biggest weighted gap", () => {
  const result = run([record(0, { correct: 6, robust: 7, polish: 5 })]);
  assert.equal(result.action, "continue");
  assert.equal(result.next_focus, "correct");
  assert.equal(result.attempts, 0);
});

test("a real gain is kept and the loop continues", () => {
  const result = run([record(0, { correct: 6, robust: 7, polish: 5 }), record(1, { correct: 7, robust: 7, polish: 5 }, { focus: "correct" })]);
  assert.equal(result.action, "continue");
  assert.equal(result.latest.accepted, true);
  assert.equal(result.best_iter, 1);
});

test("a gain inside the noise is reverted", () => {
  const result = run([record(0, { correct: 7, robust: 7, polish: 7 }), record(1, { correct: 7.5, robust: 7, polish: 7 }, { focus: "correct", spread: 0.6 })]);
  assert.equal(result.latest.accepted, false);
  assert.equal(result.latest.reason, "no_gain");
  assert.equal(result.best_iter, 0);
});

test("a feedback fix that drops another criterion is reverted even though the total rose", () => {
  const result = run([record(0, { correct: 8, robust: 8, polish: 6 }), record(1, { correct: 8, robust: 7, polish: 10 }, { focus: "polish" })]);
  assert.ok(result.latest.total > 7.5);
  assert.equal(result.latest.reason, "regression");
  assert.deepEqual(result.latest.regressed, ["robust"]);
  assert.equal(result.best_iter, 0);
});

test("a failed gate is reverted whatever the score", () => {
  const result = run([record(0, { correct: 6, robust: 6, polish: 6 }), record(1, { correct: 9, robust: 9, polish: 9 }, { focus: "correct", gates: false })]);
  assert.equal(result.latest.reason, "gate");
});

test("meeting the target with every criterion above the floor stops with success", () => {
  const result = run([record(0, { correct: 6, robust: 7, polish: 6 }), record(1, { correct: 8.5, robust: 8, polish: 7 }, { focus: "correct" })]);
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "success");
});

test("a total at target with one criterion under the floor keeps going on that criterion", () => {
  const result = run([record(0, { correct: 7, robust: 7, polish: 3 }), record(1, { correct: 10, robust: 9, polish: 3 }, { focus: "correct" })]);
  assert.equal(result.action, "continue");
  assert.equal(result.next_focus, "polish");
});

test("the budget stops the loop", () => {
  const records = [record(0, { correct: 5, robust: 5, polish: 5 })];
  for (let iter = 1; iter <= 3; iter += 1) records.push(record(iter, { correct: 5 + iter * 0.4, robust: 5, polish: 5 }, { focus: "correct" }));
  const result = run(records, { max_iterations: 3 });
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "budget");
});

test("two reverted attempts in a row is a plateau", () => {
  const result = run([
    record(0, { correct: 7, robust: 7, polish: 7 }),
    record(1, { correct: 7.1, robust: 7, polish: 7 }, { focus: "correct" }),
    record(2, { correct: 7, robust: 7.1, polish: 7 }, { focus: "robust" }),
  ]);
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "plateau");
  assert.equal(result.best_iter, 0);
});

test("shrinking gains that cannot reach the target stop as diminishing returns", () => {
  const result = run([
    record(0, { correct: 6, robust: 6, polish: 6 }),
    record(1, { correct: 7, robust: 7, polish: 6 }, { focus: "correct" }),
    record(2, { correct: 7.3, robust: 7.2, polish: 6.5 }, { focus: "robust" }),
  ]);
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "diminishing_returns");
  assert.ok(result.projection.projected_best < 8);
});

test("steady gains that still reach the target are not cut short", () => {
  const result = run([
    record(0, { correct: 5, robust: 5, polish: 5 }),
    record(1, { correct: 6, robust: 6, polish: 6 }, { focus: "correct" }),
    record(2, { correct: 7, robust: 7, polish: 7 }, { focus: "correct" }),
  ]);
  assert.equal(result.action, "continue");
});

test("the same criterion reverted twice for a regression is a conflict", () => {
  const result = run([
    record(0, { correct: 8, robust: 8, polish: 5 }),
    record(1, { correct: 8, robust: 6, polish: 9 }, { focus: "polish" }),
    record(2, { correct: 8.5, robust: 7, polish: 8 }, { focus: "polish" }),
  ], { patience: 5 });
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "conflict");
});

test("a criterion tried twice without a gain is capped and the next one is chosen", () => {
  const result = run([
    record(0, { correct: 6, robust: 7, polish: 7 }),
    record(1, { correct: 6.1, robust: 7, polish: 7 }, { focus: "correct" }),
    record(2, { correct: 6.6, robust: 7, polish: 7 }, { focus: "correct", spread: 0.8 }),
  ], { patience: 5 });
  assert.deepEqual(result.capped, ["correct"]);
  assert.equal(result.action, "continue");
  assert.equal(result.next_focus, "robust");
});

test("when every short criterion is capped the loop stops", () => {
  const result = run([
    record(0, { correct: 9, robust: 9, polish: 6 }),
    record(1, { correct: 9, robust: 9, polish: 6.1 }, { focus: "polish" }),
    record(2, { correct: 9, robust: 9, polish: 6.2 }, { focus: "polish" }),
  ], { patience: 5 });
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "capped");
});

test("locks follow the best kept score of each criterion", () => {
  const result = run([record(0, { correct: 8, robust: 6, polish: 6 })]);
  assert.equal(result.locks.correct, 7.5);
});

test("every run ends: the loop always reaches a stop within the budget", () => {
  const scores = { correct: 5, robust: 5, polish: 5 };
  const records = [record(0, scores)];
  let result = run(records);
  while (result.action === "continue") {
    const iter = records.length;
    records.push(record(iter, { ...scores, correct: 5 + (iter % 2 === 0 ? 0.1 : 0) }, { focus: result.next_focus }));
    result = run(records);
    assert.ok(iter <= 6, "the loop must stop within max_iterations");
  }
  assert.equal(result.action, "stop");
});

test("bad inputs fail with a plain message", () => {
  assert.throws(() => decide({ criteria: [] }, [record(0, {})]), InputError);
  assert.throws(() => decide(rubric(), []), /baseline/);
  assert.throws(() => decide(rubric(), [record(0, { correct: 6, robust: 6 })]), /polish/);
  assert.throws(() => decide(rubric(), [record(0, { correct: 6, robust: 6, polish: 11 })]), /0 to 10/);
  assert.throws(() => decide(rubric({ max_iterations: 99 }), [record(0, { correct: 6, robust: 6, polish: 6 })]), /max_iterations/);
  assert.throws(() => parseLedger("{nope"), /not JSON/);
});

const same = { correct: "same", robust: "same", polish: "same" };

test("scores that bounce on work judged the same never move the run and plateau stops it", () => {
  const result = run([
    record(0, { correct: 7, robust: 7, polish: 7 }),
    record(1, { correct: 8, robust: 7, polish: 7 }, { focus: "correct", vs_best: same }),
    record(2, { correct: 6.5, robust: 8, polish: 7 }, { focus: "correct", vs_best: same }),
  ]);
  assert.equal(result.reason, "plateau");
  assert.equal(result.best_iter, 0);
  assert.equal(result.best_total, 7);
  assert.equal(result.latest.compared, true);
});

test("an attempt judged better on its focus and worse on nothing is kept and only the better criterion moves", () => {
  const result = run([
    record(0, { correct: 6, robust: 7, polish: 5 }),
    record(1, { correct: 7, robust: 6, polish: 6 }, { focus: "correct", vs_best: { ...same, correct: "better" } }),
  ]);
  assert.equal(result.latest.accepted, true);
  assert.equal(result.best_iter, 1);
  assert.equal(result.best_total, round3((3 * 7 + 2 * 7 + 5) / 6));
});

test("a criterion judged better never drops its kept score when the absolute number came back lower", () => {
  const result = run([
    record(0, { correct: 7, robust: 7, polish: 5 }),
    record(1, { correct: 6.5, robust: 7, polish: 5 }, { focus: "correct", vs_best: { ...same, correct: "better" } }),
  ]);
  assert.equal(result.latest.accepted, true);
  assert.equal(result.latest.gain, 0);
  assert.equal(result.best_total, round3((3 * 7 + 2 * 7 + 5) / 6));
});

test("an attempt judged worse on any criterion is reverted whatever the totals say, and twice is a conflict", () => {
  const worse = { correct: "better", robust: "worse", polish: "same" };
  const once = run([record(0, { correct: 6, robust: 8, polish: 6 }), record(1, { correct: 9, robust: 8, polish: 6 }, { focus: "correct", vs_best: worse })]);
  assert.equal(once.latest.reason, "regression");
  assert.deepEqual(once.latest.regressed, ["robust"]);
  const twice = run([
    record(0, { correct: 6, robust: 8, polish: 6 }),
    record(1, { correct: 9, robust: 8, polish: 6 }, { focus: "correct", vs_best: worse }),
    record(2, { correct: 9, robust: 8, polish: 6 }, { focus: "correct", vs_best: worse }),
  ]);
  assert.equal(twice.reason, "conflict");
});

test("an attempt whose focus is judged the same is reverted even when its scores rose", () => {
  const result = run([record(0, { correct: 6, robust: 6, polish: 6 }), record(1, { correct: 8, robust: 8, polish: 8 }, { focus: "correct", vs_best: same })]);
  assert.equal(result.latest.reason, "no_gain");
  assert.equal(result.best_iter, 0);
});

test("a comparison on the baseline or with an unknown verdict is rejected", () => {
  assert.throws(() => run([record(0, { correct: 6, robust: 6, polish: 6 }, { vs_best: same })]), InputError);
  assert.throws(() => run([record(0, { correct: 6, robust: 6, polish: 6 }), record(1, { correct: 7, robust: 6, polish: 6 }, { focus: "correct", vs_best: { ...same, polish: "maybe" } })]), InputError);
});

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
