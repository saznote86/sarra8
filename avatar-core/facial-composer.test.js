import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarCore, EMOTION_NAMES } from './index.js';

test('maps the five vowels to the corresponding VRM viseme expressions', () => {
  const core = createAvatarCore();
  for (const [channel, expression] of Object.entries({
    A: 'aa',
    I: 'ih',
    U: 'ou',
    E: 'ee',
    O: 'oh',
  })) {
    assert.equal(core.setViseme(channel, 1).ok, true);
    core.update(1);
    assert.equal(core.inspectMorphWeights()[expression], 1);
    core.resetViseme(1);
    core.update(1);
  }
});

test('accepts P and F without mapping them to standard VRM visemes', () => {
  const core = createAvatarCore();
  assert.deepEqual(core.setViseme('P', 1), {
    ok: true,
    viseme: 'P',
    intensity: 1,
    morphTargets: [],
  });
  core.update(1);
  assert.deepEqual(core.inspectMorphWeights(), {});

  assert.equal(core.setVisemeMapping({ P: { mouthClose: 0.8 }, F: { mouthFunnel: 0.4 } }).ok, true);
  assert.equal(core.setViseme('F', 1).ok, true);
  core.update(1);
  assert.equal(core.inspectMorphWeights().mouthFunnel, 0.4);
});

test('composes emotion and lipsync while preserving the lipsync mouth priority', () => {
  const core = createAvatarCore();
  core.setEmotion('joy', 1, 80);
  core.setViseme('A', 1, 1);
  core.setSpeechAmount(1);
  core.update(1);
  const weights = core.inspectMorphWeights();
  assert.equal(weights.aa, 1);
  assert.equal(weights.mouthSmileLeft, 0.06);
  assert.equal(weights.browInnerUp, 0.06);
});

test('composes jaw opening with emotion and caps the final morph weight', () => {
  const core = createAvatarCore();
  core.setEmotion('surprise', 1, 80);
  core.setJawOpen(1.4);
  core.update(1);
  const weights = core.inspectMorphWeights();
  assert.equal(weights.jawOpen, 1);
  assert.equal(weights.eyeWideLeft, 0.48);
  assert.equal(core.setJawOpen(9).intensity, 1.5);
  core.update(0);
  assert.equal(core.inspectMorphWeights().jawOpen, 1);
});

test('transitions between visemes and resets without residual weights', () => {
  const core = createAvatarCore();
  core.setViseme('A', 1);
  core.update(1);
  core.setViseme('I', 1);
  core.update(0.04);
  const transitioning = core.inspectMorphWeights();
  assert.ok(transitioning.aa > 0 && transitioning.aa < 1);
  assert.ok(transitioning.ih > 0 && transitioning.ih < 1);

  core.resetViseme(1);
  core.update(1);
  assert.deepEqual(core.getCurrentEmotionWeights().neutre, 1);
  assert.deepEqual(core.inspectMorphWeights(), {});
});

test('bounds viseme intensity and reports invalid viseme names', () => {
  const core = createAvatarCore();
  assert.equal(core.setViseme('AA', 8).intensity, 1.5);
  assert.equal(core.setViseme('unknown', 1).error, 'unknown-viseme');
  core.update(1);
  assert.equal(core.inspectMorphWeights().aa, 1);
});

test('rejects mapped visemes that the loaded direct-morph avatar cannot display', () => {
  const core = createAvatarCore({
    adapter: {
      isLoaded: () => true,
      getAvailableExpressionTargets: () => ['mouthOpen'],
    },
  });
  assert.deepEqual(core.setViseme('AA', 1), {
    ok: false,
    viseme: 'AA',
    error: 'viseme-targets-unavailable',
    morphTargets: ['aa'],
  });
  assert.equal(core.getCurrentEmotionWeights().neutre, 1);
});

test('reports absent standard viseme targets and accepts a model-specific fallback mapping', () => {
  const core = createAvatarCore({
    adapter: {
      isLoaded: () => true,
      getAvailableExpressionTargets: () => ['E'],
    },
  });
  assert.equal(core.setViseme('EE', 1).error, 'viseme-targets-unavailable');
  assert.equal(core.setViseme('P', 1).ok, true);
  assert.equal(core.setVisemeMapping({ EE: { E: 1 } }).ok, true);
  assert.deepEqual(core.setViseme('EE', 1), { ok: true, viseme: 'EE', intensity: 1, morphTargets: ['E'] });
});

test('writes one composed morph-weight map per update through the adapter', () => {
  const writes = [];
  let faceWeight = 0;
  const core = createAvatarCore({
    adapter: {
      clearMorphWeights: () => { faceWeight = 0; },
      applyMorphWeights: (weights, options) => writes.push({ weights, options }),
    },
  });
  core.setViseme('AA', 0.5);
  core.setEmotion('joy', 1);
  core.setSupplementalMorphWeights({ cheekSquintLeft: 0.1 });
  core.update(1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].weights.aa, 0.5);
  assert.equal(writes[0].options.overrideMouth, 'block');
  assert.deepEqual(core.inspectMorphWeights(), writes[0].weights);
  faceWeight += writes[0].weights.aa;
  core.clearMorphWeights();
  core.update(0);
  faceWeight += core.inspectMorphWeights().aa;
  assert.equal(writes.length, 2);
  assert.equal(faceWeight, 0.5);
});

test('all seven emotions remain available without any AI or avatar adapter', () => {
  const core = createAvatarCore();
  for (const emotion of EMOTION_NAMES) {
    assert.equal(core.setEmotion(emotion, 1, 80).ok, true);
    core.update(1);
  }
  assert.equal(core.setViseme('OU', 0.7).ok, true);
  core.update(1);
  assert.equal(core.inspectMorphWeights().ou, 0.7);
});

test('gaze is clamped, smoothed and applies the configured anatomical limits', () => {
  const gazeWrites = [];
  const core = createAvatarCore({
    adapter: {
      getGazeCapabilities: () => ({ leftEye: true, rightEye: true }),
      applyGaze: (gaze) => gazeWrites.push(gaze),
    },
  });
  assert.deepEqual(core.setGaze(2, -2), { ok: true, target: { x: 1, y: -1 } });
  core.update(0.01);
  assert.ok(gazeWrites[0].x > 0 && gazeWrites[0].x < 0.0425);
  assert.ok(gazeWrites[0].y < 0 && gazeWrites[0].y > -0.025);
  core.update(1);
  assert.ok(Math.abs(gazeWrites.at(-1).x - 0.0425) < 0.0001);
  assert.ok(Math.abs(gazeWrites.at(-1).y + 0.025) < 0.0001);
});

test('named gaze targets and reset ease back to center', () => {
  const gazeWrites = [];
  const core = createAvatarCore({
    adapter: {
      getGazeCapabilities: () => ({ leftEye: true }),
      applyGaze: (gaze) => gazeWrites.push(gaze),
    },
  });
  assert.equal(core.setGazeTarget('left').ok, true);
  core.update(1);
  assert.ok(gazeWrites.at(-1).x < 0);
  assert.equal(core.resetGaze().ok, true);
  core.update(1);
  assert.ok(Math.abs(gazeWrites.at(-1).x) < 0.0001);
});

test('natural gaze moves gently within configured limits and can be disabled independently', () => {
  const gazeWrites = [];
  const core = createAvatarCore({
    adapter: {
      getGazeCapabilities: () => ({ leftEye: true }),
      applyGaze: (gaze) => gazeWrites.push(gaze),
    },
  });
  assert.equal(core.setNaturalGaze(true).ok, true);
  for (let frame = 0; frame < 100; frame += 1) core.update(0.016);
  assert.ok(Math.abs(gazeWrites.at(-1).x) <= 0.0425);
  assert.ok(Math.abs(gazeWrites.at(-1).y) <= 0.025);
  assert.equal(core.setNaturalGaze(false).ok, true);
  for (let frame = 0; frame < 100; frame += 1) core.update(0.016);
  assert.ok(Math.abs(gazeWrites.at(-1).x) < 0.0001);
});

test('gaze requests report unavailable when the avatar has no eye or look-at control', () => {
  const core = createAvatarCore({ adapter: { getGazeCapabilities: () => ({}) } });
  assert.equal(core.setGaze(0.5, 0).error, 'gaze-unavailable');
  assert.equal(core.setGazeTarget('right').error, 'gaze-unavailable');
});

test('gaze can use configured direct expression morphs when eye bones are absent', () => {
  const core = createAvatarCore({
    adapter: {
      getGazeCapabilities: () => ({}),
      getAvailableExpressionTargets: () => ['eyeLookOutLeft', 'eyeLookInRight'],
      applyMorphWeights: () => {},
    },
  });
  assert.equal(core.setGazeMapping({ left: { eyeLookOutLeft: 1, eyeLookInRight: 1 } }).ok, true);
  assert.equal(core.setGazeTarget('left').ok, true);
  core.update(1);
  assert.ok(Math.abs(core.inspectMorphWeights().eyeLookOutLeft - 1) < 0.001);
  assert.ok(Math.abs(core.inspectMorphWeights().eyeLookInRight - 1) < 0.001);
});

test('manual blink supports smooth whole-face and individual-eye control', () => {
  const core = createAvatarCore({
    adapter: {
      getBlinkCapabilities: () => ({ left: true, right: true }),
      getAvailableExpressionTargets: () => ['eyeBlinkLeft', 'eyeBlinkRight'],
    },
  });
  assert.deepEqual(core.setBlink(0.8), { ok: true, intensity: 0.8, side: 'both' });
  core.update(1);
  assert.equal(core.inspectMorphWeights().eyeBlinkLeft, 0.8);
  assert.equal(core.inspectMorphWeights().eyeBlinkRight, 0.8);
  core.setBlink(0.3, 'left');
  core.update(1);
  assert.equal(core.inspectMorphWeights().eyeBlinkLeft, 0.3);
  assert.equal(core.inspectMorphWeights().eyeBlinkRight, 0.8);
});

test('one-sided blink is supported only when that eye has a target', () => {
  const core = createAvatarCore({
    adapter: {
      getBlinkCapabilities: () => ({ left: true, right: false }),
      getAvailableExpressionTargets: () => ['eyeBlinkLeft'],
    },
  });
  assert.equal(core.setBlink(0.7, 'left').ok, true);
  assert.equal(core.setBlink(0.7, 'right').error, 'right-blink-unavailable');
  assert.equal(core.triggerBlink(1, 'left').ok, true);
  core.update(0.06);
  assert.ok(core.getBlinkWeights().left > 0);
  assert.equal(core.getBlinkWeights().right, 0);
  assert.equal(core.resetBlink().ok, true);
});

test('triggered blink has a smooth pulse and configurable timing', () => {
  const core = createAvatarCore({
    adapter: {
      getBlinkCapabilities: () => ({ left: true, right: true }),
      getAvailableExpressionTargets: () => ['eyeBlinkLeft', 'eyeBlinkRight'],
    },
  });
  assert.equal(core.setBlinkOptions({ durationMs: 200, rightOffsetMs: 0 }).ok, true);
  assert.equal(core.triggerBlink().ok, true);
  core.update(0.05);
  const closing = core.getBlinkWeights().left;
  core.update(0.05);
  const peak = core.getBlinkWeights().left;
  core.update(0.05);
  const opening = core.getBlinkWeights().left;
  assert.ok(closing > 0 && closing < peak);
  assert.ok(opening < peak && opening > 0);
});

test('automatic blinks use varied intervals and can be disabled', () => {
  const core = createAvatarCore({
    composer: undefined,
    adapter: {
      getBlinkCapabilities: () => ({ left: true }),
      getAvailableExpressionTargets: () => ['eyeBlinkLeft'],
    },
  });
  assert.equal(core.setBlinkOptions({
    intervalMs: [100, 100],
    doubleBlinkChance: 0,
    durationMs: 100,
    rightOffsetMs: 0,
  }).ok, true);
  assert.equal(core.setAutoBlink(true).ok, true);
  core.update(0.09);
  core.update(0.015);
  assert.ok(core.getBlinkWeights().left > 0);
  assert.equal(core.setAutoBlink(false).ok, true);
  core.resetBlink();
  core.update(0.2);
  assert.equal(core.inspectMorphWeights().eyeBlinkLeft, undefined);
});

test('reports missing eye bones and blink morphs explicitly', () => {
  const core = createAvatarCore({
    adapter: {
      getGazeCapabilities: () => ({ leftEye: false, rightEye: false, lookAt: false }),
      getBlinkCapabilities: () => ({ left: false, right: false }),
      getAvailableExpressionTargets: () => ['mouthOpen'],
    },
  });
  assert.equal(core.setGaze(0, 0).error, 'gaze-unavailable');
  assert.equal(core.setBlink(1).error, 'blink-unavailable');
  assert.equal(core.triggerBlink().error, 'blink-unavailable');
  assert.equal(core.setAutoBlink(true).error, 'blink-unavailable');
});

test('gaze, blink, emotions, visemes and facial morphs compose without duplicate writes', () => {
  const writes = [];
  const gazeWrites = [];
  const core = createAvatarCore({
    adapter: {
      getGazeCapabilities: () => ({ leftEye: true, rightEye: true }),
      getBlinkCapabilities: () => ({ left: true, right: true }),
      getAvailableExpressionTargets: () => ['eyeBlinkLeft', 'eyeBlinkRight', 'aa'],
      applyGaze: (gaze, options) => gazeWrites.push({ gaze, options }),
      applyMorphWeights: (weights, options) => writes.push({ weights, options }),
    },
  });
  core.setNaturalGaze(false);
  core.setGazeTarget('right');
  core.setBlink(0.5);
  core.setEmotion('joy', 1, 80);
  core.setViseme('AA', 0.5);
  core.update(1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].weights.eyeBlinkLeft, 0.5);
  assert.equal(writes[0].weights.eyeBlinkRight, 0.5);
  assert.equal(writes[0].weights.aa, 0.5);
  assert.equal(writes[0].options.overrideBlink, 'block');
  assert.equal(writes[0].options.overrideLookAt, 'block');
  assert.equal(gazeWrites.length, 1);
  assert.equal(gazeWrites[0].options.overrideLookAt, 'block');
});

test('all seven emotions and five visemes remain available with gaze and blink active', () => {
  const core = createAvatarCore({
    adapter: {
      getGazeCapabilities: () => ({ lookAt: true }),
      getBlinkCapabilities: () => ({ left: true }),
      applyGaze: () => {},
    },
  });
  core.setNaturalGaze(false);
  core.setBlink(0.2);
  for (const [emotion, viseme] of [
    ['joy', 'AA'],
    ['sadness', 'IH'],
    ['anger', 'OU'],
    ['surprise', 'EE'],
    ['tenderness', 'OH'],
    ['concentration', 'P'],
    ['neutral', 'F'],
  ]) {
    assert.equal(core.setEmotion(emotion, 1, 80).ok, true);
    assert.equal(core.setViseme(viseme, 0.7).ok, true);
    core.update(1);
  }
  assert.equal(core.inspectMorphWeights().eyeBlinkLeft, 0.2);
});

test('resetBehavior returns facial state to neutral and disables autonomous motion', () => {
  const core = createAvatarCore({
    adapter: {
      getGazeCapabilities: () => ({ leftEye: true }),
      getBlinkCapabilities: () => ({ left: true }),
      getAvailableExpressionTargets: () => ['eyeBlinkLeft', 'aa'],
      applyGaze: () => {},
    },
  });
  core.setGaze(1, 1);
  core.setBlink(1);
  core.setEmotion('joy', 1);
  core.setViseme('AA', 1);
  assert.equal(core.resetBehavior().ok, true);
  core.update(1);
  assert.equal(core.getCurrentEmotionWeights().neutre, 1);
  assert.deepEqual(core.getBlinkWeights(), { left: 0, right: 0 });
  assert.deepEqual(core.inspectMorphWeights(), {});
});
