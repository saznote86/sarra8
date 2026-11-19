import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AvatarCore,
  EMOTION_NAMES,
  EMOTION_PROFILES,
  ExpressionMixer,
  createAvatarCore,
  normalizeEmotionName,
} from './index.js';

const closeTo = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
};

test('exports the nine emotion profiles without changing existing values', () => {
  assert.deepEqual(EMOTION_NAMES, [
    'neutre',
    'joie',
    'tristesse',
    'colere',
    'surprise',
    'peur',
    'degout',
    'tendresse',
    'concentration',
  ]);
  assert.deepEqual(EMOTION_PROFILES.joie, {
    mouthSmileLeft: 0.5,
    mouthSmileRight: 0.5,
    cheekSquintLeft: 0.24,
    cheekSquintRight: 0.24,
    browInnerUp: 0.06,
  });
  assert.deepEqual(EMOTION_PROFILES.tristesse, {
    browInnerUp: 0.32,
    mouthFrownLeft: 0.3,
    mouthFrownRight: 0.3,
    eyeSquintLeft: 0.08,
    eyeSquintRight: 0.08,
  });
  assert.deepEqual(EMOTION_PROFILES.colere, {
    browDownLeft: 0.4,
    browDownRight: 0.4,
    eyeSquintLeft: 0.2,
    eyeSquintRight: 0.2,
    mouthFrownLeft: 0.1,
    mouthFrownRight: 0.1,
  });
  assert.deepEqual(EMOTION_PROFILES.surprise, {
    eyeWideLeft: 0.48,
    eyeWideRight: 0.48,
    browOuterUpLeft: 0.35,
    browOuterUpRight: 0.35,
    browInnerUp: 0.14,
  });
  assert.deepEqual(EMOTION_PROFILES.peur, {
    browInnerUp: 0.5,
    browOuterUpLeft: 0.14,
    browOuterUpRight: 0.14,
    eyeWideLeft: 0.42,
    eyeWideRight: 0.42,
    mouthStretchLeft: 0.3,
    mouthStretchRight: 0.3,
  });
  assert.deepEqual(EMOTION_PROFILES.degout, {
    noseSneerLeft: 0.42,
    noseSneerRight: 0.42,
    mouthUpperUpLeft: 0.3,
    mouthUpperUpRight: 0.3,
    browDownLeft: 0.16,
    browDownRight: 0.16,
    eyeSquintLeft: 0.12,
    eyeSquintRight: 0.12,
  });
  assert.deepEqual(EMOTION_PROFILES.tendresse, {
    mouthSmileLeft: 0.22,
    mouthSmileRight: 0.22,
    cheekSquintLeft: 0.2,
    cheekSquintRight: 0.2,
    browInnerUp: 0.12,
    eyeSquintLeft: 0.05,
    eyeSquintRight: 0.05,
  });
  assert.deepEqual(EMOTION_PROFILES.concentration, {
    browDownLeft: 0.22,
    browDownRight: 0.22,
    eyeSquintLeft: 0.18,
    eyeSquintRight: 0.18,
    browInnerUp: 0.05,
  });
});

test('all nine emotion names are accepted and produce their profile targets', () => {
  for (const emotion of EMOTION_NAMES) {
    const mixer = new ExpressionMixer();
    assert.equal(mixer.setEmotion(emotion, 1, 420), true);
    const contributions = mixer.update(1);
    if (emotion === 'neutre') assert.deepEqual(contributions, {});
    else assert.deepEqual(Object.keys(contributions).sort(), Object.keys(EMOTION_PROFILES[emotion]).sort());
  }
});

test('preserves the original exponential transition and 0.001 snap threshold', () => {
  const mixer = new ExpressionMixer();
  mixer.setEmotionMix({ joie: 1 }, 420);
  const factor = 1 - Math.exp(-0.1 * (1000 / 420));
  const contributions = mixer.update(0.1);
  closeTo(mixer.getCurrentWeights().joie, factor);
  closeTo(mixer.getCurrentWeights().neutre, 1 - factor);
  closeTo(contributions.mouthSmileLeft, 0.5 * factor);

  mixer.update(3);
  assert.equal(mixer.getCurrentWeights().joie, 1);
  assert.equal(mixer.getCurrentWeights().neutre, 0);
});

test('preserves the minimum transition duration and default transition duration', () => {
  const minimum = new ExpressionMixer();
  minimum.setEmotionMix({ joie: 1 }, 1);
  closeTo(minimum.update(0.08).mouthSmileLeft, 0.5 * (1 - Math.exp(-1)));

  const defaultDuration = new ExpressionMixer();
  defaultDuration.setEmotionMix({ joie: 1 }, 0);
  closeTo(defaultDuration.update(0.1).mouthSmileLeft, 0.5 * (1 - Math.exp(-0.1 * (1000 / 420))));
});

test('bounds emotion intensities to the existing 0..1.5 range', () => {
  const mixer = new ExpressionMixer();
  assert.equal(mixer.setEmotion('joy', 8, 420), true);
  assert.equal(mixer.getTargetWeights().joie, 1.5);
  mixer.setEmotion('sadness', -2, 420);
  assert.equal(mixer.getTargetWeights().tristesse, 0);
  assert.equal(mixer.getTargetWeights().neutre, 1);
});

test('reset transitions back to neutral and removes previous emotion contributions', () => {
  const mixer = new ExpressionMixer();
  mixer.setEmotion('joy', 1, 80);
  mixer.update(1);
  mixer.resetExpression(80);
  assert.deepEqual(mixer.getTargetWeights(), {
    neutre: 1,
    joie: 0,
    tristesse: 0,
    colere: 0,
    surprise: 0,
    peur: 0,
    degout: 0,
    tendresse: 0,
    concentration: 0,
  });
  assert.deepEqual(mixer.update(1), {});
});

test('successive emotions fade out old contributions without residual target weights', () => {
  const mixer = new ExpressionMixer();
  mixer.setEmotion('joy', 1, 80);
  mixer.update(1);
  mixer.setEmotion('sadness', 1, 80);
  mixer.update(1);
  assert.equal(mixer.getCurrentWeights().joie, 0);
  assert.equal(mixer.getCurrentWeights().tristesse, 1);
  assert.equal(mixer.getTargetWeights().joie, 0);
  assert.equal(mixer.getTargetWeights().tristesse, 1);
  const contributions = mixer.update(0);
  assert.equal(contributions.mouthSmileLeft, undefined);
  assert.equal(contributions.mouthFrownLeft, 0.3);
});

test('normalizes the same English and accented emotion aliases', () => {
  assert.equal(normalizeEmotionName('Joie'), 'joie');
  assert.equal(normalizeEmotionName('sadness'), 'tristesse');
  assert.equal(normalizeEmotionName('Colère'), 'colere');
  assert.equal(normalizeEmotionName('tenderness'), 'tendresse');
});

test('facade validates loaded avatar targets and supports VRM expression target categories', () => {
  const core = createAvatarCore({
    adapter: {
      isLoaded: () => true,
      getAvailableExpressionTargets: () => ({
        morphTargets: ['mouthSmileLeft'],
        customExpressions: ['mouthSmileRight'],
        standardExpressions: ['browInnerUp'],
      }),
    },
  });
  const result = core.setEmotion('joy', 2, 420);
  assert.deepEqual(result, {
    ok: true,
    emotion: 'joie',
    intensity: 1.5,
    duration: 420,
    morphTargets: ['mouthSmileLeft', 'mouthSmileRight', 'browInnerUp'],
  });
});

test('facade refuses unloaded or unsupported avatar emotions without changing state', () => {
  const unloaded = new AvatarCore({ adapter: { isLoaded: () => false } });
  assert.equal(unloaded.setEmotion('joy').error, 'avatar-not-loaded');
  assert.equal(unloaded.getCurrentEmotionWeights().neutre, 1);

  const unsupported = new AvatarCore({
    adapter: {
      isLoaded: () => true,
      getAvailableExpressionTargets: () => ['jawOpen'],
    },
  });
  assert.equal(unsupported.setEmotion('joy').error, 'emotion-targets-unavailable');
  assert.equal(unsupported.getCurrentEmotionWeights().neutre, 1);
});

test('facade keeps unavailable controls explicit and exposes calibration parameters', () => {
  const core = createAvatarCore();
  assert.equal(core.setGaze(0, 0).ok, false);
  assert.equal(core.resetGaze().ok, false);
  assert.equal(core.setBlink(1).ok, false);
  assert.equal(core.resetBlink().ok, false);
  assert.equal(core.applyCalibration({}).ok, true);
  assert.equal(core.exportCalibration().ok, true);
  assert.equal(core.resetExpression().ok, true);
});

test('Core snapshot exposes immutable facial state and explicit convergence', () => {
  const core = createAvatarCore({
    adapter: {
      getGazeCapabilities: () => ({ leftEye: true }),
      getBlinkCapabilities: () => ({ left: true, right: true }),
      applyGaze: () => {},
      applyMorphWeights: () => {},
      getAppliedWeights: () => coreSnapshotWeights,
    },
  });
  let coreSnapshotWeights = {};
  core.setEmotion('joy', 1, 80);
  core.setViseme('A', 1, 80);
  core.setGaze(0.5, 0);
  core.update(1);
  coreSnapshotWeights = core.inspectMorphWeights();
  core.update(1);
  core.update(1);
  core.update(1);
  core.markFrameRendered();
  core.markFrameRendered();
  const snapshot = core.getSnapshot();
  assert.equal(snapshot.frame, 4);
  assert.equal(snapshot.emotions.joie, 1);
  assert.equal(snapshot.viseme, 'AA');
  assert.equal(snapshot.convergence.mixerConverged, true);
  assert.equal(snapshot.convergence.composerConverged, true);
  assert.equal(snapshot.convergence.captureAllowed, true);
  assert.deepEqual(snapshot.appliedMorphWeights, coreSnapshotWeights);
  assert.throws(() => { snapshot.emotions.joie = 0; }, TypeError);
});

test('Studio secondary motion freeze is reversible after success or cancellation', () => {
  const core = createAvatarCore({
    adapter: {
      getBlinkCapabilities: () => ({ left: true, right: true }),
      getGazeCapabilities: () => ({ leftEye: true }),
    },
  });
  core.setAutoBlink(true);
  core.setNaturalGaze(true);
  const frozen = core.freezeSecondaryMotion();
  assert.equal(frozen.autoBlink, false);
  assert.equal(frozen.naturalGaze, false);
  assert.equal(core.getSnapshot().secondaryMotion.frozen, true);
  const restored = core.restoreSecondaryMotion();
  assert.equal(restored.autoBlink, true);
  assert.equal(restored.naturalGaze, true);
  assert.equal(core.getSnapshot().secondaryMotion.frozen, false);
});
