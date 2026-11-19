import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NaturalJawEnvelope,
  NaturalLipsyncDemo,
  frameRateIndependentBlend,
  sampleNaturalLipsyncDemo,
  sanitizeNaturalLipsyncConfig,
} from './natural-lipsync.js';

test('natural lipsync demo works with and without external state', () => {
  for (const state of [undefined, null, { humanMotion: { blinkIntervalMs: NaN } }]) {
    const demo = new NaturalLipsyncDemo();
    assert.deepEqual(demo.start(1000, state), { ok: true, active: true, noSettings: true });
    assert.equal(demo.sample(1600).speaking, true);
    assert.equal(demo.stop().active, false);
  }
});

test('demo stop restores normal state and does not mutate persisted state', () => {
  const state = { humanMotion: { blinkIntervalMs: 3000 } };
  const snapshot = JSON.stringify(state);
  const demo = new NaturalLipsyncDemo();
  demo.start(1000, state);
  assert.deepEqual(demo.stop().restored, state);
  assert.equal(JSON.stringify(state), snapshot);
});

test('frame-rate-independent smoothing converges within tolerance', () => {
  const run = (steps, delta) => {
    let value = 0;
    for (let index = 0; index < steps; index++) {
      value = frameRateIndependentBlend(value, 1, 0.1, delta);
    }
    return value;
  };
  assert.ok(Math.abs(run(60, 1 / 60) - run(120, 1 / 120)) < 0.02);
  assert.ok(Math.abs(run(600, 1 / 600) - run(60, 1 / 60)) < 0.02);
});

test('silence threshold rejects micro-noise and hangover keeps speech active briefly', () => {
  const jaw = new NaturalJawEnvelope();
  assert.equal(jaw.update(0.002, 0.016).jawOpen, 0);
  jaw.update(0.08, 0.016);
  assert.ok(jaw.update(0.001, 0.1).speaking);
  assert.equal(jaw.update(0.001, 0.5).speaking, false);
});

test('demo visemes are interpolated and finite', () => {
  const first = sampleNaturalLipsyncDemo(0.1);
  const second = sampleNaturalLipsyncDemo(0.12);
  assert.equal(first.speaking, true);
  assert.ok(second.visemes.A > first.visemes.A);
  assert.ok(Number.isFinite(second.jawOpen));
});

test('configuration sanitizes NaN, Infinity and out-of-range values', () => {
  const config = sanitizeNaturalLipsyncConfig({
    silenceThreshold: NaN,
    silenceHangoverSeconds: Infinity,
    attackSeconds: -20,
    releaseSeconds: 99,
    jawScale: 2,
  });
  assert.equal(Number.isFinite(config.silenceThreshold), true);
  assert.equal(Number.isFinite(config.silenceHangoverSeconds), true);
  assert.equal(config.attackSeconds, 0.01);
  assert.ok(config.releaseSeconds <= 1.5);
  assert.equal(config.jawScale, 1);
});
