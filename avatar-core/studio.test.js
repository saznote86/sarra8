import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CalibrationRunner,
  STUDIO_SCENARIOS,
  analyzeFacialState,
  applyBoundedProposal,
  captureCanvas,
  comparePixelCaptures,
  createCalibrationProfile,
  interpolateMorphWeights,
  parseCalibrationProfileJSON,
  proposeFacialCalibration,
  recordTransitionPeaks,
  validateCalibrationProfile,
  waitForCoreConvergence,
} from './studio.js';
import { AvatarCore, EMOTION_NAMES } from './expression-mixer.js';
import { PROFILE_EMOTION_NAMES, PROFILE_VISEME_NAMES } from './calibration-profile.js';

test('Sarra Studio exposes the bounded emotion and Lipsync calibration controls', () => {
  const app = readFileSync(new URL('../Sarra — avatar VRM & lipsync avancé.html', import.meta.url), 'utf8');
  assert.match(app, /PROFILE_EMOTION_NAMES\.map/);
  assert.match(app, /PROFILE_VISEME_NAMES\.map/);
  assert.match(app, /scaleControl\('parameters\.jawScale'/);
  assert.match(app, /scaleControl\('transitions\.emotionScale'/);
  assert.match(app, /scaleControl\('transitions\.visemeScale'/);
  assert.match(app, /readCalibrationProfile=current=>/);
  assert.match(app, /requestAvatarStudio\('apply-profile',\{profile:p\}\)/);
});

test('Studio scenarios are stable and cover emotion, viseme, jaw, gaze, blink, and combined tests', () => {
  const ids = STUDIO_SCENARIOS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const emotion of EMOTION_NAMES) assert.ok(ids.includes(`emotion-${emotion}`));
  for (const viseme of ['A', 'I', 'U', 'E', 'O', 'P', 'F']) assert.ok(ids.includes(`viseme-${viseme}`));
  assert.ok(ids.includes('jaw-open'));
  assert.ok(ids.includes('gaze-left'));
  assert.ok(ids.includes('blink'));
  assert.ok(ids.includes('combined'));
});

test('technical analysis reports missing targets, invalid weights, and conflict warnings', () => {
  const result = analyzeFacialState({
    availableTargets: ['jawOpen', 'mouthSmileLeft'],
    requiredTargets: ['eyeBlinkLeft'],
    weights: { jawOpen: 1.4, mouthSmileLeft: 0.8 },
    speechAmount: 0.8,
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(({ code }) => code === 'missing-target'));
  assert.ok(result.issues.some(({ code }) => code === 'weight-out-of-range'));
  assert.ok(result.issues.some(({ code }) => code === 'speech-emotion-overlap'));
});

test('transition analysis retains the largest positive or negative rate across frames', () => {
  let peaks = recordTransitionPeaks({}, { smile: 0.4 }, 0.02);
  assert.equal(peaks.smile, 20);
  peaks = recordTransitionPeaks({ smile: 0.4 }, { smile: 0.7 }, 0.02, peaks);
  assert.equal(peaks.smile, 20);
  peaks = recordTransitionPeaks({ smile: 0.7 }, { smile: 0.2 }, 0.01, peaks);
  assert.ok(Math.abs(peaks.smile + 50) < 1e-12);
  assert.ok(analyzeFacialState({ transitionDelta: peaks }).issues.some(
    ({ code, target, rate }) => code === 'abrupt-transition' && target === 'smile' && Math.abs(rate + 50) < 1e-12,
  ));
});

test('Studio-only consonant morph interpolation is bounded and settles at its target', () => {
  const target = { PP: 0.432, mouthClose: 0.217 };
  let current = interpolateMorphWeights({}, target, 1 / 60, 80);
  assert.ok(current.PP > 0 && current.PP < target.PP);
  assert.ok(current.PP / (1 / 60) < 8);
  current = interpolateMorphWeights(current, {}, 1 / 60, 80);
  assert.ok(current.PP > 0 && current.PP < target.PP);
  for (let frame = 0; frame < 60; frame += 1) {
    current = interpolateMorphWeights(current, target, 1 / 60, 96);
  }
  assert.equal(current.PP, target.PP);
  assert.equal(current.mouthClose, target.mouthClose);
});

test('canvas capture includes metadata and reports capture errors explicitly', async () => {
  const canvas = { width: 20, height: 10, toDataURL: () => 'data:image/png;base64,abc' };
  const captured = await captureCanvas(canvas, { scenarioId: 'emotion-joie' });
  assert.equal(captured.image, 'data:image/png;base64,abc');
  assert.equal(captured.width, 20);
  assert.equal(captured.metadata.scenarioId, 'emotion-joie');
  await assert.rejects(captureCanvas(null), /capture-canvas-unavailable/);
  await assert.rejects(captureCanvas({ toDataURL() { throw new Error('tainted'); } }), /capture-failed: tainted/);
});

test('pixel comparison validates dimensions and measures channel differences', () => {
  assert.deepEqual(comparePixelCaptures({ width: 1 }, { width: 1 }), { ok: false, error: 'incompatible-captures' });
  const result = comparePixelCaptures(
    { width: 1, height: 1, data: [0, 0, 0, 255] },
    { width: 1, height: 1, data: [16, 0, 0, 255] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.meanAbsoluteDifference, 4);
  assert.equal(result.changedPixelChannelRatio, 0.25);
});

test('calibration profiles validate model and rig identity', () => {
  const model = { id: 'sarra7.vrm', fingerprint: 'sha256-1', rigSignature: 'rig-1' };
  const profile = createCalibrationProfile({
    model,
    mappings: { visemes: { AA: { aa: 1 } } },
    parameters: { emotionScales: { joie: 1 }, jawScale: 1 },
  });
  assert.deepEqual(validateCalibrationProfile(profile, model), { ok: true, compatible: true, reasons: [] });
  assert.equal(validateCalibrationProfile(profile, { ...model, rigSignature: 'rig-2' }).compatible, false);
  assert.equal(validateCalibrationProfile(profile, { ...model, fingerprint: 'sha256-2' }).compatible, false);
  assert.equal(validateCalibrationProfile({ schema: 'other' }).compatible, false);
});

test('profile JSON import validates schema, calibration limits, mappings, and model compatibility', () => {
  const model = { id: 'sarra7.vrm', fingerprint: 'sha256-1', rigSignature: 'rig-1' };
  const profile = createCalibrationProfile({
    model,
    mappings: { visemes: { EE: { E: 1 } }, legacyVisemes: { P: { PP: 0.4 } } },
    parameters: { emotionScales: { joie: 1 }, jawScale: 1 },
  });
  const parsed = parseCalibrationProfileJSON(JSON.stringify(profile), model);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.profile.mappings.visemes.EE.E, 1);
  assert.equal(parseCalibrationProfileJSON('{not-json', model).error, 'invalid-profile-json');
  assert.equal(parseCalibrationProfileJSON(JSON.stringify(profile), { ...model, id: 'other.vrm' }).error, 'profile-incompatible');

  const invalidScale = structuredClone(profile);
  invalidScale.parameters.jawScale = 4;
  assert.ok(validateCalibrationProfile(invalidScale, model).reasons.includes('invalid-profile-jawScale'));
  const invalidMapping = structuredClone(profile);
  invalidMapping.mappings.visemes.EE.E = Number.NaN;
  assert.equal(validateCalibrationProfile(invalidMapping, model).compatible, false);
});

test('calibration proposals are bounded, reversible, and reject unsupported paths', () => {
  const profile = createCalibrationProfile({
    model: { id: 'sarra7.vrm', fingerprint: 'sha256-1', rigSignature: 'rig-1' },
    mappings: {},
    parameters: { emotionScales: { joie: 1 }, jawScale: 1 },
  });
  const proposed = applyBoundedProposal(profile, { parameter: 'jawScale', value: 9 });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.profile.parameters.jawScale, 1.2);
  assert.equal(profile.parameters.jawScale, 1);
  assert.equal(applyBoundedProposal(profile, { parameter: 'emotionScales.joie', value: 0.7 }).profile.parameters.emotionScales.joie, 0.8);
  assert.equal(applyBoundedProposal(profile, { parameter: 'transitions.emotionScale', value: 9 }).profile.transitions.emotionScale, 1.2);
  assert.equal(profile.transitions.emotionScale, 1);
  assert.equal(applyBoundedProposal(profile, { parameter: 'vrmFile', value: 0 }).ok, false);
});

test('facial calibration proposals target the subsystem measured by each issue', () => {
  const profile = createCalibrationProfile({
    model: { id: 'sarra7.vrm', fingerprint: 'sha256-1', rigSignature: 'rig-1' },
    mappings: {},
    parameters: { emotionScales: { joie: 1 }, jawScale: 1, blinkScale: 1 },
    transitions: { emotionScale: 1, visemeScale: 1, gazeSmoothingScale: 1, blinkDurationScale: 1 },
  });
  const analysis = { issues: [
    { code: 'abrupt-transition', target: 'aa' },
    { code: 'abrupt-transition', target: 'eyeBlinkLeft' },
    { code: 'abrupt-transition', target: 'jawOpen' },
    { code: 'abrupt-transition', target: 'browInnerUp' },
  ] };

  assert.deepEqual(
    proposeFacialCalibration(profile, analysis, { stimulus: { viseme: 'A', emotion: 'joie' } })
      .map(({ parameter }) => parameter),
    ['transitions.visemeScale', 'transitions.blinkDurationScale', 'jawScale', 'transitions.emotionScale'],
  );
  assert.equal(profile.transitions.visemeScale, 1);
  assert.deepEqual(proposeFacialCalibration(profile, { issues: [
    { code: 'speech-emotion-overlap' },
  ] }, { stimulus: { emotion: 'joie' } }), [{
    parameter: 'emotionScales.joie',
    value: 0.8,
    reason: 'Atténuer l’expression de bouche pendant la parole.',
  }]);
});

test('bounded calibration proposals support every emotion and viseme shown in Studio', () => {
  const profile = createCalibrationProfile({
    mappings: {},
    parameters: { emotionScales: {}, visemeScales: {} },
    transitions: {},
  });
  for (const emotion of PROFILE_EMOTION_NAMES) {
    const result = applyBoundedProposal(profile, { parameter: `emotionScales.${emotion}`, value: 1.1 });
    assert.equal(result.ok, true, `emotion ${emotion} is configurable`);
    assert.equal(result.profile.parameters.emotionScales[emotion], 1.1);
  }
  for (const viseme of PROFILE_VISEME_NAMES) {
    const result = applyBoundedProposal(profile, { parameter: `visemeScales.${viseme}`, value: 0.9 });
    assert.equal(result.ok, true, `viseme ${viseme} is configurable`);
    assert.equal(result.profile.parameters.visemeScales[viseme], 0.9);
  }
});

test('CalibrationRunner evaluates proposals and always restores the original profile', async () => {
  const baseline = createCalibrationProfile({
    model: { id: 'sarra7.vrm', fingerprint: 'sha256-1', rigSignature: 'rig-1' },
    mappings: {},
    parameters: { jawScale: 1 },
  });
  let restored = null;
  const runner = new CalibrationRunner({
    runScenario: async (scenario) => ({ weights: {}, availableTargets: [], scenarioId: scenario.id }),
    restore: async (profile) => { restored = profile; },
  });
  const evaluated = await runner.evaluateProposals(
    baseline,
    [{ parameter: 'jawScale', value: 1.1 }],
    async (profile) => ({ score: profile.parameters.jawScale * 100 }),
  );
  assert.equal(evaluated.best.profile.parameters.jawScale, 1.1);
  assert.equal(evaluated.requiresApproval, true);
  assert.equal(evaluated.saved, false);
  assert.equal(restored.parameters.jawScale, 1);
});

test('Studio convergence waiter rejects timeout and accepts a converged snapshot', async () => {
  const timeout = await waitForCoreConvergence({
    getSnapshot: () => ({ convergence: { captureAllowed: false } }),
  }, { timeoutMs: 5, intervalMs: 1 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error, 'capture-convergence-timeout');

  const accepted = await waitForCoreConvergence({
    getSnapshot: () => ({ convergence: { captureAllowed: true } }),
  });
  assert.equal(accepted.ok, true);
});

test('Core applies and exports bounded calibration without changing default emotion behavior', () => {
  const core = new AvatarCore();
  const baseline = core.mixer.update(0.1);
  assert.ok(Object.keys(baseline).length === 0);
  const applied = core.applyCalibration({
    parameters: {
      emotionScales: { joie: 1.2 },
      jawScale: 1.1,
      visemeScales: { AA: 1.2 },
    },
    transitions: { emotionScale: 1.1, visemeScale: 1.05, gazeSmoothingScale: 0.9, blinkDurationScale: 1.1 },
  });
  assert.equal(applied.ok, true);
  assert.equal(core.exportCalibration().parameters.emotionScales.joie, 1.2);
  assert.equal(core.exportCalibration().transitions.emotionScale, 1.1);
  core.setEmotion('joie', 1, 420);
  assert.ok(Math.abs(core.mixer.speed - 1000 / 462) < 1e-12);
  assert.equal(core.applyCalibration({ emotionScales: { unknown: 1 } }).ok, false);
  assert.equal(core.exportCalibration().transitions.emotionScale, 1.1);
});

test('Core imports and exports model-specific facial mappings and rejects malformed maps', () => {
  const core = new AvatarCore();
  const result = core.applyCalibration({
    parameters: { jawScale: 1 },
    transitions: {},
    mappings: {
      visemes: { EE: { E: 0.7 } },
      gaze: { left: { eyeLookOutLeft: 0.5 } },
      blink: { left: { eyeBlinkLeft: 0.8 } },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mappings.visemes.EE, { E: 0.7 });
  const exported = core.exportCalibration();
  assert.deepEqual(exported.mappings.visemes.EE, { E: 0.7 });
  assert.deepEqual(exported.mappings.gaze.left, { eyeLookOutLeft: 0.5 });
  assert.deepEqual(exported.mappings.blink.left, { eyeBlinkLeft: 0.8 });

  const before = core.exportCalibration();
  const rejected = core.applyCalibration({
    parameters: { jawScale: 1.1 },
    mappings: { visemes: { EE: { E: 2 } } },
  });
  assert.equal(rejected.ok, false);
  assert.deepEqual(core.exportCalibration(), before);
});

test('versioned profile JSON round-trips calibration and rejected imports leave it unchanged', () => {
  const model = { id: 'sarra7.vrm', fingerprint: 'sha256-1', rigSignature: 'rig-1' };
  const core = new AvatarCore({ adapter: { getModelIdentity: () => model } });
  const applied = core.applyCalibration({
    parameters: { emotionScales: { joie: 1.15 }, jawScale: 1.1, visemeScales: { AA: 0.9 } },
    transitions: { emotionScale: 1.1, visemeScale: 0.95, gazeSmoothingScale: 1, blinkDurationScale: 1.05 },
    mappings: {
      visemes: { AA: { aa: 0.8 } },
      gaze: { left: { eyeLookOutLeft: 0.5 } },
      blink: { left: { eyeBlinkLeft: 0.8 } },
    },
  });
  assert.equal(applied.ok, true);
  const active = core.exportCalibration();
  const profile = createCalibrationProfile({
    model,
    mappings: active.mappings,
    parameters: active.parameters,
    transitions: active.transitions,
    results: [{ scenarioId: 'emotion-joie', score: 100 }],
    createdAt: '2026-11-01T12:00:00.000Z',
  });
  const serialized = JSON.stringify(profile);
  const parsed = parseCalibrationProfileJSON(serialized, model);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.profile.schemaVersion, 1);
  assert.deepEqual(parsed.profile.model, model);

  const restored = new AvatarCore({ adapter: { getModelIdentity: () => model } });
  assert.equal(restored.applyCalibration(parsed.profile).ok, true);
  assert.deepEqual(restored.exportCalibration().parameters, active.parameters);
  assert.deepEqual(restored.exportCalibration().transitions, active.transitions);
  assert.deepEqual(restored.exportCalibration().mappings, active.mappings);

  const invalid = structuredClone(parsed.profile);
  invalid.parameters.jawScale = 4;
  const beforeRejectedImport = restored.exportCalibration();
  const rejectedImport = parseCalibrationProfileJSON(JSON.stringify(invalid), model);
  assert.equal(rejectedImport.ok, false);
  assert.deepEqual(restored.exportCalibration().parameters, beforeRejectedImport.parameters);
  assert.deepEqual(restored.exportCalibration().transitions, beforeRejectedImport.transitions);
  assert.deepEqual(restored.exportCalibration().mappings, beforeRejectedImport.mappings);
});

test('versioned profiles preserve non-neutral calibration across a serialized restart', () => {
  const model = { id: 'sarra7.vrm', fingerprint: 'sha256-restart', rigSignature: 'rig-restart' };
  const firstRun = new AvatarCore({
    adapter: { getModelIdentity: () => model },
  });
  assert.equal(firstRun.applyCalibration({
    parameters: {
      emotionScales: { joie: 1.17, colere: 0.91 },
      visemeScales: { AA: 0.88, F: 1.12 },
      jawScale: 1.08,
      gazeScale: 0.93,
      blinkScale: 1.11,
    },
    transitions: {
      emotionScale: 1.09,
      visemeScale: 0.92,
      gazeSmoothingScale: 1.04,
      blinkDurationScale: 0.89,
    },
    mappings: {
      visemes: { AA: { aa: 0.82 } },
      gaze: { left: { eyeLookOutLeft: 0.73 } },
      blink: { left: { eyeBlinkLeft: 0.84 } },
    },
  }).ok, true);

  const saved = firstRun.exportCalibrationProfile({ results: [{ scenarioId: 'emotion-joie', score: 100 }] });
  assert.equal(saved.ok, true);
  const serializedProfile = JSON.stringify(saved.profile);

  const restartedCore = new AvatarCore({
    adapter: { getModelIdentity: () => model },
  });
  const parsed = parseCalibrationProfileJSON(serializedProfile, model);
  assert.equal(parsed.ok, true);
  assert.equal(restartedCore.applyCalibration(parsed.profile).ok, true);
  assert.deepEqual(restartedCore.exportCalibration().parameters, saved.profile.parameters);
  assert.deepEqual(restartedCore.exportCalibration().transitions, saved.profile.transitions);
  assert.deepEqual(restartedCore.exportCalibration().mappings, saved.profile.mappings);
});

test('Core rejects incompatible model and Core-version profiles without changing active calibration', () => {
  const model = { id: 'sarra7.vrm', fingerprint: 'sha256-1', rigSignature: 'rig-1' };
  const core = new AvatarCore({ adapter: { getModelIdentity: () => model } });
  assert.equal(core.applyCalibration({ parameters: { jawScale: 1.14 } }).ok, true);
  const before = core.exportCalibration();
  const profile = createCalibrationProfile({
    model,
    parameters: { jawScale: 0.9 },
    mappings: { visemes: { AA: { aa: 1 } } },
  });
  const incompatibleModel = structuredClone(profile);
  incompatibleModel.model.fingerprint = 'sha256-other';
  const incompatibleVersion = structuredClone(profile);
  incompatibleVersion.coreVersion = '0.5.0';

  assert.equal(core.applyCalibration(incompatibleModel).error, 'profile-incompatible');
  assert.equal(core.applyCalibration(incompatibleVersion).error, 'profile-incompatible');
  const active = core.exportCalibration();
  delete active.createdAt;
  const unchanged = structuredClone(before);
  delete unchanged.createdAt;
  assert.deepEqual(active, unchanged);
});

test('Core accepts Phase 5 profiles containing legacy viseme mappings', () => {
  const model = { id: 'sarra7.vrm', fingerprint: 'sha256-phase5', rigSignature: 'rig-phase5' };
  const core = new AvatarCore({ adapter: { getModelIdentity: () => model } });
  const phase5Profile = createCalibrationProfile({
    model,
    mappings: {
      visemes: { AA: { aa: 1 } },
      legacyVisemes: { A: { A: 0.75 }, P: { PP: 0.4 } },
      gaze: { left: { eyeLookOutLeft: 1 } },
      blink: { left: { eyeBlinkLeft: 1 } },
    },
    parameters: { emotionScales: { joie: 1.12 }, jawScale: 1.08 },
  });

  assert.equal(core.applyCalibration(phase5Profile).ok, true);
  assert.deepEqual(core.composer.visemeMapping.AA, { A: 0.75 });
  assert.deepEqual(core.composer.visemeMapping.P, { PP: 0.4 });
});
