import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_CALIBRATION_MODES,
  proposeAutomaticCalibration,
  runAutoCalibration,
  summarizeCalibrationRun,
} from './auto-calibration.js';
import { STUDIO_SCENARIOS, CalibrationRunner } from './studio.js';

const profile = {
  schema: 'sarra-avatar-calibration',
  schemaVersion: 1,
  coreVersion: '0.4.0',
  parameters: {
    emotionScales: { joie: 1, peur: 1 },
    visemeScales: { AA: 1 },
    jawScale: 1,
    gazeScale: 1,
    blinkScale: 1,
  },
  transitions: { emotionScale: 1, visemeScale: 1, gazeSmoothingScale: 1, blinkDurationScale: 1 },
  mappings: { visemes: {}, gaze: {}, blink: {} },
  results: [],
  calibrationVersion: 1,
  createdAt: new Date().toISOString(),
};

const runWith = (issues) => ({
  results: [
    {
      scenarioId: 'emotion-joie',
      analysis: { score: 60, passed: false, issues },
    },
    {
      scenarioId: 'emotion-peur',
      analysis: { score: 80, passed: true, issues: [] },
    },
  ],
});

test('exposes the two calibration modes', () => {
  assert.deepEqual([...AUTO_CALIBRATION_MODES], ['auto', 'manual']);
});

test('summarizes a run with average score and weakest scenarios', () => {
  const summary = summarizeCalibrationRun(runWith([]));
  assert.equal(summary.scenarios, 2);
  assert.equal(summary.averageScore, 70);
  assert.equal(summary.weakest[0].scenarioId, 'emotion-joie');
  assert.equal(summary.passed, false);
});

test('merges per-scenario proposals into bounded values', () => {
  const proposals = proposeAutomaticCalibration(profile, runWith([
    { code: 'speech-emotion-overlap', severity: 'warning', message: 'x' },
    { code: 'jaw-pucker-conflict', severity: 'warning', message: 'y' },
  ]));
  const byName = Object.fromEntries(proposals.map((entry) => [entry.parameter, entry]));
  assert.ok(byName['emotionScales.joie']);
  assert.equal(byName['emotionScales.joie'].value, 0.8);
  assert.equal(byName.jawScale.value, 0.95);
  for (const proposal of proposals) {
    assert.ok(proposal.value >= 0.8 && proposal.value <= 1.2);
  }
});

test('manual mode returns candidates and never saves', async () => {
  const runner = new CalibrationRunner({
    runScenario: async (scenario) => ({
      weights: {},
      availableTargets: [],
      requiredTargets: scenario.requiredTargets,
    }),
  });
  const result = await runAutoCalibration({
    profile,
    runner,
    scenarios: STUDIO_SCENARIOS.slice(0, 2),
    mode: 'manual',
    evaluate: async () => ({ score: 90, passed: true, issues: [] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.saved, false);
});

test('auto mode returns an improving profile for explicit approval', async () => {
  const runner = new CalibrationRunner({
    runScenario: async (scenario) => ({
      weights: { mouthSmileLeft: 0.4 },
      speechAmount: 1,
      availableTargets: ['mouthSmileLeft'],
      requiredTargets: scenario.requiredTargets,
    }),
  });
  let call = 0;
  const result = await runAutoCalibration({
    profile,
    runner,
    scenarios: STUDIO_SCENARIOS.slice(0, 1),
    mode: 'auto',
    // first call scores the baseline, the following ones score the proposals
    evaluate: async () => ({ score: (call += 1) === 1 ? 50 : 95, passed: true, issues: [] }),
  });
  assert.equal(result.saved, false);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.improved, true);
  assert.equal(result.reason, 'approval-required');
  assert.equal(result.proposedProfile.parameters.emotionScales.neutre, 0.8);
});

test('auto mode returns no profile when nothing improves', async () => {
  const runner = new CalibrationRunner({
    runScenario: async (scenario) => ({
      weights: {},
      availableTargets: [],
      requiredTargets: scenario.requiredTargets,
    }),
  });
  const result = await runAutoCalibration({
    profile,
    runner,
    scenarios: STUDIO_SCENARIOS.slice(0, 1),
    mode: 'auto',
    evaluate: async () => ({ score: 42, passed: false, issues: [] }),
  });
  assert.equal(result.saved, false);
  assert.equal(result.proposedProfile, undefined);
  assert.equal(result.reason, 'no-improvement');
});

test('rejects unknown modes and missing runners', async () => {
  assert.equal((await runAutoCalibration({ profile, runner: null, mode: 'manual' })).error, 'calibration-runner-required');
  const runner = new CalibrationRunner({ runScenario: async () => ({}) });
  assert.equal((await runAutoCalibration({ profile, runner, mode: 'magic' })).error, 'unsupported-calibration-mode');
});
