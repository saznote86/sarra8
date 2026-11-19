import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTemporaryProposal,
  createPhoneticReference,
  measureLipsyncRun,
  proposeLipsyncCalibration,
  samplePhoneticReference,
} from './lipsync-calibration.js';

test('local French reference produces bounded vowel and consonant visemes', () => {
  const reference = createPhoneticReference({
    text: 'Papa mange une pomme avec Fanny.',
    duration: 3,
  });
  assert.equal(reference.timeline.length > 10, true);
  assert.equal(reference.timeline.every((event) => ['A', 'E', 'I', 'O', 'U', 'P', 'F'].includes(event.viseme)), true);
});

test('reference sampling preserves silence at the beginning', () => {
  const reference = createPhoneticReference({ text: 'Papa', duration: 2 });
  const frame = samplePhoneticReference(reference, 0);
  assert.equal(Math.max(...Object.values(frame)), 0);
});

test('lipsync measurement returns error without frames', () => {
  assert.deepEqual(
    measureLipsyncRun({ reference: createPhoneticReference({ text: 'Papa', duration: 2 }), appliedFrames: [] }),
    { ok: false, error: 'no-lipsync-frames', mse: null, frameCount: 0 }
  );
});

test('calibration proposes bounded reversible latency and jaw corrections', () => {
  const proposal = proposeLipsyncCalibration(
    { rmse: 0.4 },
    { rmse: 0.2, measuredOffsetMs: 250, silenceResidual: 0.08 }
  );
  assert.deepEqual(proposal.recommendations.map((item) => item.parameter), ['latencyMs', 'jawScale', 'visemeScale']);
  assert.equal(proposal.recommendations[0].value, 120);
});

test('temporary proposal applies only supported bounded Core calibration', () => {
  const calibration = { parameters: { jawScale: 1, visemeScales: {}, emotionScales: {} }, transitions: { visemeScale: 1 }, mappings: {} };
  const core = {
    exportCalibration: () => calibration,
    applyCalibration: (next) => {
      assert.equal(next.parameters.jawScale, 0.9);
      assert.equal(next.parameters.visemeScales.AA, 1.1);
      return { ok: true };
    },
  };
  assert.deepEqual(applyTemporaryProposal(core, { temporary: true, recommendations: [
    { parameter: 'jawScale', value: 0.9 }, { parameter: 'visemeScale', value: 1.1 },
  ] }), { ok: true });
});
