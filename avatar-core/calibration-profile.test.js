import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  PROFILE_EMOTION_NAMES,
  PROFILE_SCALE_LIMITS,
  PROFILE_VISEME_NAMES,
  validateCalibrationParameters,
} from './calibration-profile.js';
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const validSettings = () => ({
  mappings: {},
  parameters: {
    emotionScales: Object.fromEntries(PROFILE_EMOTION_NAMES.map((name) => [name, 1])),
    visemeScales: Object.fromEntries(PROFILE_VISEME_NAMES.map((name) => [name, 1])),
    jawScale: 1,
  },
  transitions: { emotionScale: 1, visemeScale: 1 },
});

test('calibration panel settings cover all supported emotions and lipsync channels', () => {
  assert.deepEqual(PROFILE_EMOTION_NAMES, [
    'neutre', 'joie', 'tristesse', 'colere', 'surprise', 'peur', 'degout',
    'tendresse', 'concentration',
  ]);
  assert.deepEqual(PROFILE_VISEME_NAMES, ['AA', 'IH', 'OU', 'EE', 'OH', 'P', 'F']);
  assert.deepEqual(PROFILE_SCALE_LIMITS, { min: 0.8, max: 1.2, step: 0.01 });
  assert.deepEqual(validateCalibrationParameters(validSettings()).reasons, []);
});

test('emotion, viseme, jaw and transition settings reject out-of-range values', () => {
  const settings = validSettings();
  settings.parameters.emotionScales.peur = 1.21;
  settings.parameters.visemeScales.F = 0.79;
  settings.parameters.jawScale = 1.21;
  settings.transitions.visemeScale = 0.79;

  assert.deepEqual(validateCalibrationParameters(settings).reasons, [
    'invalid-profile-emotion-scales',
    'invalid-profile-viseme-scales',
    'invalid-profile-jawScale',
    'invalid-profile-transitions',
  ]);
});

test('the plural calibration module is removed from the package', () => {
  assert.equal(existsSync(new URL('./calibration-profiles.js', import.meta.url)), false);
  assert.equal(packageJson.exports['./calibration-profiles'], undefined);
});
