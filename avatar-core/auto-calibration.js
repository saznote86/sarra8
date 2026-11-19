/**
 * Automatic vs. manual facial auto-calibration.
 *
 * Both modes run the same deterministic Studio scenarios and reuse the bounded
 * proposals from `studio.js`. The difference is the last step:
 *
 *   manual : candidates are returned for the operator to inspect and approve;
 *   auto   : the best strictly-improving candidate is returned for explicit
 *            approval in the calibration panel.
 *
 * No cloud call, no vision model: everything is computed from morph weights.
 */
import {
  CalibrationRunner,
  STUDIO_SCENARIOS,
  proposeFacialCalibration,
} from './studio.js';
import { PROFILE_SCALE_LIMITS } from './calibration-profile.js';

export const AUTO_CALIBRATION_MODES = Object.freeze(['auto', 'manual']);

export function summarizeCalibrationRun(run) {
  const results = Array.isArray(run?.results) ? run.results : [];
  const scores = results.map((entry) => Number(entry?.analysis?.score) || 0);
  const issues = results.flatMap((entry) =>
    (entry?.analysis?.issues || []).map((issue) => ({ scenarioId: entry.scenarioId, ...issue })));
  const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
  return {
    scenarios: results.length,
    averageScore: Math.round(average * 10) / 10,
    weakest: results
      .slice()
      .sort((a, b) => (a.analysis?.score || 0) - (b.analysis?.score || 0))
      .slice(0, 3)
      .map((entry) => ({ scenarioId: entry.scenarioId, score: entry.analysis?.score || 0 })),
    issues,
    passed: results.every((entry) => entry?.analysis?.passed !== false),
  };
}

/**
 * Merge the per-scenario proposals into one bounded value per parameter.
 * Conflicting directions average out instead of oscillating.
 */
export function proposeAutomaticCalibration(profile, run, scenarios = STUDIO_SCENARIOS) {
  const results = Array.isArray(run?.results) ? run.results : [];
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const merged = new Map();
  for (const entry of results) {
    const scenario = byId.get(entry.scenarioId) || {
      id: entry.scenarioId,
      stimulus: {},
      requiredTargets: [],
    };
    for (const proposal of proposeFacialCalibration(profile, entry.analysis, scenario)) {
      const current = merged.get(proposal.parameter);
      if (current) {
        current.values.push(proposal.value);
        current.reasons.add(proposal.reason);
      } else {
        merged.set(proposal.parameter, {
          parameter: proposal.parameter,
          values: [proposal.value],
          reasons: new Set([proposal.reason]),
        });
      }
    }
  }
  return [...merged.values()].map((entry) => {
    const value = entry.values.reduce((sum, item) => sum + item, 0) / entry.values.length;
    return {
      parameter: entry.parameter,
      value: Math.round(Math.max(PROFILE_SCALE_LIMITS.min, Math.min(PROFILE_SCALE_LIMITS.max, value)) * 1000) / 1000,
      reason: [...entry.reasons].join(' '),
      votes: entry.values.length,
    };
  });
}

/**
 * @param {object} options
 * @param {object} options.profile   Current calibration profile (schema v1).
 * @param {CalibrationRunner} options.runner
 * @param {'auto'|'manual'} [options.mode]
 * @param {(profile: object) => Promise<object>} [options.evaluate] Scoring function
 *        used by the runner to compare candidates.
 */
export async function runAutoCalibration({
  profile,
  runner,
  scenarios = STUDIO_SCENARIOS,
  mode = 'manual',
  evaluate,
} = {}) {
  if (!AUTO_CALIBRATION_MODES.includes(mode)) {
    return { ok: false, error: 'unsupported-calibration-mode' };
  }
  if (!(runner instanceof CalibrationRunner)) {
    return { ok: false, error: 'calibration-runner-required' };
  }
  if (!profile || typeof profile !== 'object' || !profile.parameters) {
    return { ok: false, error: 'invalid-calibration-profile' };
  }

  const run = await runner.run(scenarios);
  const summary = summarizeCalibrationRun(run);
  const proposals = proposeAutomaticCalibration(profile, run, scenarios);
  const result = {
    ok: true,
    mode,
    run,
    summary,
    proposals,
    evaluation: null,
    improved: false,
    requiresApproval: true,
    saved: false,
  };

  if (typeof evaluate !== 'function') {
    if (mode === 'auto') result.error = 'evaluator-required';
    return result;
  }

  const evaluation = await runner.evaluateProposals(profile, proposals, evaluate);
  result.evaluation = evaluation;
  const baseline = evaluation.candidates.find((candidate) => candidate.baseline);
  const best = evaluation.best;
  result.improved = Boolean(
    best && !best.baseline && baseline && best.result.score > baseline.result.score,
  );

  if (mode !== 'auto') return result;

  if (!result.improved) {
    result.reason = 'no-improvement';
    return result;
  }
  result.proposedProfile = best.profile;
  result.reason = 'approval-required';
  return result;
}
