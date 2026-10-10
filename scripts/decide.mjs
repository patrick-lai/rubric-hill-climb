import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULTS = { target: 8, max_iterations: 6, min_gain: 0.25, regression_tolerance: 0.5, patience: 2 };

const round = (value) => Math.round(value * 1000) / 1000;

const COMPARISONS = ["better", "same", "worse"];

export class InputError extends Error {}

function fail(message) {
  throw new InputError(message);
}

export function normalise(rubric) {
  if (typeof rubric !== "object" || rubric === null) fail("rubric must be an object");
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (rubric[key] === undefined) continue;
    if (typeof rubric[key] !== "number" || !Number.isFinite(rubric[key])) fail(`${key} must be a number`);
    config[key] = rubric[key];
  }
  if (config.target <= 0 || config.target > 10) fail("target must be in (0, 10]");
  if (!Number.isInteger(config.max_iterations) || config.max_iterations < 1 || config.max_iterations > 10) fail("max_iterations must be an integer from 1 to 10");
  if (!Number.isInteger(config.patience) || config.patience < 1) fail("patience must be a positive integer");
  if (config.min_gain < 0 || config.regression_tolerance < 0) fail("min_gain and regression_tolerance cannot be negative");
  config.floor = rubric.floor === undefined ? Math.max(0, config.target - 1.5) : rubric.floor;
  if (typeof config.floor !== "number" || config.floor < 0 || config.floor > config.target) fail("floor must be a number from 0 to target");
  if (!Array.isArray(rubric.criteria) || rubric.criteria.length === 0) fail("criteria must list at least one criterion");
  const ids = new Set();
  let sum = 0;
  for (const criterion of rubric.criteria) {
    if (typeof criterion?.id !== "string" || criterion.id === "") fail("every criterion needs an id");
    if (ids.has(criterion.id)) fail(`criterion ${criterion.id} is listed twice`);
    ids.add(criterion.id);
    if (typeof criterion.weight !== "number" || !(criterion.weight > 0)) fail(`criterion ${criterion.id} needs a positive weight`);
    sum += criterion.weight;
  }
  config.criteria = rubric.criteria.map((criterion) => ({ id: criterion.id, weight: criterion.weight / sum }));
  return config;
}

export function parseLedger(text) {
  const records = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      fail(`ledger line ${index + 1} is not JSON`);
    }
  }
  return records;
}

function checkRecord(config, record, position) {
  const label = `ledger record ${position + 1}`;
  if (typeof record !== "object" || record === null) fail(`${label} is not an object`);
  if (!Number.isInteger(record.iter) || record.iter !== position) fail(`${label} must have iter ${position}`);
  if (typeof record.scores !== "object" || record.scores === null) fail(`${label} needs scores`);
  for (const { id } of config.criteria) {
    const score = record.scores[id];
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10) fail(`${label} needs a 0 to 10 score for ${id}`);
  }
  if (record.spread !== undefined && (typeof record.spread !== "number" || record.spread < 0)) fail(`${label} spread must be a non-negative number`);
  if (position > 0 && (typeof record.focus !== "string" || !config.criteria.some((criterion) => criterion.id === record.focus))) fail(`${label} needs a focus that names a criterion`);
  if (record.vs_best === undefined) return;
  if (position === 0) fail(`${label} is the baseline and has nothing to compare against`);
  if (typeof record.vs_best !== "object" || record.vs_best === null) fail(`${label} vs_best must be an object`);
  for (const { id } of config.criteria) {
    if (!COMPARISONS.includes(record.vs_best[id])) fail(`${label} vs_best needs better, same or worse for ${id}`);
  }
}

function judgeByScores(config, kept, best, record, gates) {
  const candidate = total(config, record.scores);
  const need = Math.max(config.min_gain, record.spread ?? 0);
  const regressed = config.criteria.filter(({ id }) => record.scores[id] < best[id] - config.regression_tolerance).map(({ id }) => id);
  let reason = "ok";
  if (!gates) reason = "gate";
  else if (regressed.length > 0) reason = "regression";
  else if (candidate < kept.total + need) reason = "no_gain";
  return { scores: { ...record.scores }, candidate, needed: round(need), reason, regressed };
}

function judgeByComparison(config, kept, record, gates) {
  const regressed = config.criteria.filter(({ id }) => record.vs_best[id] === "worse").map(({ id }) => id);
  let reason = "ok";
  if (!gates) reason = "gate";
  else if (regressed.length > 0) reason = "regression";
  else if (record.vs_best[record.focus] !== "better") reason = "no_gain";
  const scores = Object.fromEntries(config.criteria.map(({ id }) => [id, record.vs_best[id] === "better" ? Math.max(kept.scores[id], record.scores[id]) : kept.scores[id]]));
  return { scores, candidate: total(config, scores), needed: null, reason, regressed };
}

export function total(config, scores) {
  return round(config.criteria.reduce((sum, { id, weight }) => sum + weight * scores[id], 0));
}

function meetsTarget(config, scores, gates) {
  return gates && total(config, scores) >= config.target && config.criteria.every(({ id }) => scores[id] >= config.floor);
}

export function replay(config, records) {
  if (records.length === 0) fail("the ledger needs a baseline record (iter 0)");
  records.forEach((record, position) => checkRecord(config, record, position));
  const baseline = records[0];
  let kept = { iter: 0, scores: { ...baseline.scores }, total: total(config, baseline.scores), gates: baseline.gates !== false };
  const best = Object.fromEntries(config.criteria.map(({ id }) => [id, baseline.scores[id]]));
  const history = [kept];
  const verdicts = [];
  for (const record of records.slice(1)) {
    const gates = record.gates !== false;
    const compared = record.vs_best !== undefined;
    const { scores, candidate, needed, reason, regressed } = compared ? judgeByComparison(config, kept, record, gates) : judgeByScores(config, kept, best, record, gates);
    const accepted = reason === "ok";
    verdicts.push({ iter: record.iter, focus: record.focus, total: candidate, gain: round(candidate - kept.total), needed, compared, accepted, reason, regressed });
    if (accepted) {
      const rose = candidate > kept.total;
      kept = { iter: record.iter, scores, total: candidate, gates };
      for (const { id } of config.criteria) best[id] = Math.max(best[id], scores[id]);
      if (rose || !compared) history.push(kept);
    }
  }
  return { kept, best, history, verdicts };
}

function cappedCriteria(verdicts) {
  const capped = [];
  const ids = new Set(verdicts.map((verdict) => verdict.focus));
  for (const id of ids) {
    let misses = 0;
    for (const verdict of verdicts) {
      if (verdict.focus !== id) continue;
      misses = verdict.accepted ? 0 : misses + 1;
    }
    if (misses >= 2) capped.push(id);
  }
  return capped.sort();
}

function nextFocus(config, kept, capped) {
  const open = config.criteria
    .filter(({ id }) => !capped.includes(id) && (kept.scores[id] < config.target || kept.scores[id] < config.floor))
    .map(({ id, weight }) => ({ id, gap: weight * (Math.max(config.target, config.floor) - kept.scores[id]) }))
    .sort((a, b) => b.gap - a.gap || a.id.localeCompare(b.id));
  return open[0]?.id ?? null;
}

function projection(config, history, attempts) {
  const gains = history.slice(1).map((entry, index) => round(entry.total - history[index].total));
  const last = gains[gains.length - 1];
  if (last === undefined) return null;
  const remaining = config.max_iterations - attempts;
  let reach = last * remaining;
  const before = gains[gains.length - 2];
  if (before !== undefined && before > 0) {
    const ratio = last / before;
    if (ratio < 1) reach = Math.min(reach, (last * ratio) / (1 - ratio));
  }
  return { last_gain: last, remaining, reach: round(reach), projected_best: round(history[history.length - 1].total + reach) };
}

export function decide(rubric, records) {
  const config = normalise(rubric);
  const { kept, best, history, verdicts } = replay(config, records);
  const attempts = verdicts.length;
  const capped = cappedCriteria(verdicts);
  const projected = projection(config, history, attempts);
  const state = {
    best_iter: kept.iter,
    best_total: kept.total,
    attempts,
    remaining: config.max_iterations - attempts,
    latest: verdicts[verdicts.length - 1] ?? null,
    locks: Object.fromEntries(Object.entries(best).map(([id, score]) => [id, round(score - config.regression_tolerance)])),
    capped,
    projection: projected,
  };
  const stop = (reason, detail) => ({ action: "stop", reason, detail, next_focus: null, ...state });
  if (meetsTarget(config, kept.scores, kept.gates)) return stop("success", `total ${kept.total} meets target ${config.target} and every criterion is at least ${round(config.floor)}`);
  const conflict = config.criteria.map(({ id }) => id).find((id) => verdicts.filter((verdict) => verdict.reason === "regression" && verdict.regressed.includes(id)).length >= 2);
  if (conflict !== undefined) return stop("conflict", `two attempts were reverted for dropping ${conflict}; the criteria trade off and need a human decision`);
  if (attempts >= config.max_iterations) return stop("budget", `${attempts} attempts used; best total ${kept.total} is short of ${config.target}`);
  let trailing = 0;
  for (let index = verdicts.length - 1; index >= 0 && !verdicts[index].accepted; index -= 1) trailing += 1;
  if (trailing >= config.patience) return stop("plateau", `${trailing} attempts in a row were reverted; further tries are not producing gains`);
  if (projected !== null && projected.projected_best < config.target) {
    return stop("diminishing_returns", `last gain ${projected.last_gain}; at most ${projected.reach} more is reachable, so ${projected.projected_best} stays under ${config.target}`);
  }
  const focus = nextFocus(config, kept, capped);
  if (focus === null) return stop("capped", "every criterion that is still short has already been tried twice without a gain");
  return { action: "continue", reason: attempts === 0 ? "baseline" : "improving", detail: `work on ${focus}`, next_focus: focus, ...state };
}

function main(argv) {
  const [rubricPath, ledgerPath] = argv;
  if (rubricPath === undefined || ledgerPath === undefined) {
    console.error("usage: node decide.mjs RUBRIC.json LEDGER.jsonl");
    return 2;
  }
  try {
    const rubric = JSON.parse(readFileSync(rubricPath, "utf8"));
    const records = parseLedger(readFileSync(ledgerPath, "utf8"));
    console.log(JSON.stringify(decide(rubric, records), null, 2));
    return 0;
  } catch (error) {
    console.error(`decide: ${error instanceof InputError ? error.message : `cannot read the inputs (${error.message})`}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
