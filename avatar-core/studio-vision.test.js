import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCapture,
  compareCaptures,
  validateCaptureQuality,
  waitForCaptureStability,
} from './studio-vision.js';

function image(width = 160, height = 160, color = 128, variance = 40) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    const pixel = index / 4;
    const variation = variance ? ((pixel * 17 + pixel * pixel * 3) % (variance * 2)) - variance : 0;
    data[index] = data[index + 1] = data[index + 2] = Math.max(0, Math.min(255, color + variation));
    data[index + 3] = 255;
  }
  return { width, height, data };
}

test('valid capture is analyzed with documented deterministic metrics', () => {
  const capture = image();
  const result = analyzeCapture(capture);
  assert.equal(result.ok, true);
  assert.ok(result.metrics.faceRegion);
  assert.ok(result.metrics.mouthOpening.confidence >= 0);
  assert.ok(result.limits.length > 0);
});

test('empty capture and resolution failure are explicit', () => {
  assert.equal(validateCaptureQuality(null).ok, false);
  assert.equal(validateCaptureQuality({ width: 160, height: 160, data: new Uint8ClampedArray() }).ok, false);
  const low = validateCaptureQuality(image(80, 80));
  assert.ok(low.issues.some((issue) => issue.code === 'resolution-too-low'));
});

test('dark and overexposed captures are detected', () => {
  const dark = validateCaptureQuality(image(160, 160, 4, 2));
  assert.ok(dark.issues.some((issue) => issue.code === 'capture-too-dark'));
  const bright = validateCaptureQuality(image(160, 160, 250, 2));
  assert.ok(bright.issues.some((issue) => issue.code === 'capture-overexposed'));
});

test('identical and different captures are compared without inventing improvement', () => {
  const first = image();
  const same = compareCaptures(first, image());
  assert.equal(same.ok, true);
  assert.ok(same.rawDifference.meanAbsoluteDifference < 0.001);
  const different = image(160, 160, 128, 100);
  const changed = compareCaptures(first, different);
  assert.equal(changed.ok, true);
  assert.ok(changed.rawDifference.meanAbsoluteDifference > 0);
  assert.deepEqual(changed.limits, ['Une hausse ou baisse de la différence brute ne prouve pas automatiquement une amélioration.']);
});

test('low-confidence and unavailable visual measures are represented explicitly', () => {
  const result = analyzeCapture(image());
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.equal(typeof result.metrics.eyeDetail.confidence, 'number');
  assert.ok(result.metrics.mouthOpening.limits.length > 0);
  assert.equal(result.metrics.eyelidOpening.value, 'unavailable');
  assert.equal(result.metrics.eyelidOpening.confidence, 0);
});

test('repeated identical captures produce repeatable local metrics', () => {
  const capture = image();
  const first = analyzeCapture(capture);
  const second = analyzeCapture(image());
  assert.equal(first.metrics.mouthVariance.value, second.metrics.mouthVariance.value);
  assert.equal(first.metrics.mouthLipVariation.value, second.metrics.mouthLipVariation.value);
  assert.equal(first.metrics.eyeRegionalVariance.value.left, second.metrics.eyeRegionalVariance.value.left);
});

test('capture stability waits for consecutive stable frames', async () => {
  const stableCapture = image(160, 160, 128, 40);
  const result = await waitForCaptureStability(() => stableCapture,
    { frames: 3, intervalMs: 1, timeoutMs: 200, threshold: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.samples, 3);
});

test('capture stability reports timeout rather than fixed-delay success', async () => {
  let value = 0;
  const result = await waitForCaptureStability(() => {
    value += 1;
    return image(160, 160, value, 20);
  }, { frames: 3, intervalMs: 1, timeoutMs: 15, threshold: 0.25 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'capture-stability-timeout');
});
