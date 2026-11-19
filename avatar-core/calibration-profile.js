export const CALIBRATION_PROFILE_VERSION = 1;
export const AVATAR_CORE_VERSION = '0.4.0';

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
export const PROFILE_SCALE_LIMITS = Object.freeze({ min: 0.8, max: 1.2, step: 0.01 });
const PROFILE_PARAMETER_LIMITS = PROFILE_SCALE_LIMITS;
// Canonical order used by the Studio (the seven requested emotions first).
export const PROFILE_EMOTION_NAMES = Object.freeze([
  'neutre', 'joie', 'tristesse', 'colere', 'surprise', 'peur', 'degout',
  'tendresse', 'concentration',
]);
export const PROFILE_VISEME_NAMES = Object.freeze(['AA', 'IH', 'OU', 'EE', 'OH', 'P', 'F']);
export const PROFILE_EMOTIONS = new Set(PROFILE_EMOTION_NAMES);
const PROFILE_MAPPING_KEYS = Object.freeze({
  visemes: new Set(PROFILE_VISEME_NAMES),
  legacyVisemes: new Set(['A', 'E', 'I', 'O', 'U', 'P', 'F']),
  gaze: new Set(['left', 'right', 'up', 'down']),
  blink: new Set(['left', 'right']),
});
const PROFILE_TRANSITIONS = new Set([
  'emotionScale', 'visemeScale', 'gazeSmoothingScale', 'blinkDurationScale',
]);

function validateScaleGroup(value, allowedNames) {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([name, scale]) =>
    allowedNames.has(name) && Number.isFinite(scale) &&
    scale >= PROFILE_PARAMETER_LIMITS.min && scale <= PROFILE_PARAMETER_LIMITS.max);
}

function validateMorphMapping(value) {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([target, weight]) =>
    target.length > 0 && Number.isFinite(weight) && weight >= 0 && weight <= 1.5);
}

function validateProfileMappings(mappings) {
  if (!isRecord(mappings)) return false;
  return Object.entries(mappings).every(([group, entries]) => {
    const allowedNames = PROFILE_MAPPING_KEYS[group];
    return !!allowedNames && isRecord(entries) &&
      Object.entries(entries).every(([name, weights]) =>
        allowedNames.has(name) && validateMorphMapping(weights));
  });
}

export function createCalibrationProfile({
  model = {},
  mappings = {},
  parameters = {},
  transitions = {
    emotionScale: 1, visemeScale: 1, gazeSmoothingScale: 1, blinkDurationScale: 1,
  },
  results = [],
  createdAt = new Date().toISOString(),
} = {}) {
  return {
    schema: 'sarra-avatar-calibration',
    schemaVersion: CALIBRATION_PROFILE_VERSION,
    model: {
      id: String(model.id || ''),
      fingerprint: String(model.fingerprint || ''),
      rigSignature: String(model.rigSignature || ''),
    },
    coreVersion: AVATAR_CORE_VERSION,
    mappings: clone(mappings),
    parameters: clone(parameters),
    transitions: clone(transitions),
    results: clone(results),
    createdAt,
    calibrationVersion: 1,
  };
}

/**
 * Validate calibration settings independently of model identity and timestamps.
 */
export function validateCalibrationParameters(content) {
  const reasons = [];
  if (!isRecord(content)) return { ok: false, reasons: ['invalid-profile-content'] };
  if (!validateProfileMappings(content.mappings) || !isRecord(content.parameters) ||
      !isRecord(content.transitions)) {
    reasons.push('invalid-profile-content');
  }
  if (isRecord(content.parameters)) {
    const parameters = content.parameters;
    const knownKeys = new Set(['emotionScales', 'visemeScales', 'jawScale', 'gazeScale', 'blinkScale']);
    if (Object.keys(parameters).some((key) => !knownKeys.has(key))) reasons.push('unsupported-profile-parameter');
    if (parameters.emotionScales != null && !validateScaleGroup(parameters.emotionScales, PROFILE_EMOTIONS)) {
      reasons.push('invalid-profile-emotion-scales');
    }
    if (parameters.visemeScales != null && !validateScaleGroup(parameters.visemeScales, PROFILE_MAPPING_KEYS.visemes)) {
      reasons.push('invalid-profile-viseme-scales');
    }
    for (const key of ['jawScale', 'gazeScale', 'blinkScale']) {
      const value = parameters[key];
      if (value != null && (!Number.isFinite(value) ||
          value < PROFILE_PARAMETER_LIMITS.min || value > PROFILE_PARAMETER_LIMITS.max)) {
        reasons.push(`invalid-profile-${key}`);
      }
    }
  }
  if (isRecord(content.transitions) && Object.entries(content.transitions).some(([name, value]) =>
    !PROFILE_TRANSITIONS.has(name) || !Number.isFinite(value) ||
    value < PROFILE_PARAMETER_LIMITS.min || value > PROFILE_PARAMETER_LIMITS.max)) {
    reasons.push('invalid-profile-transitions');
  }
  return { ok: reasons.length === 0, reasons };
}

export function validateCalibrationProfile(
  profile,
  expectedModel = {},
  expectedCoreVersion = AVATAR_CORE_VERSION,
) {
  if (!isRecord(expectedModel)) expectedModel = {};
  const reasons = [];
  if (!isRecord(profile) || profile.schema !== 'sarra-avatar-calibration' ||
      profile.schemaVersion !== CALIBRATION_PROFILE_VERSION) {
    return { ok: false, compatible: false, reasons: ['unsupported-profile-schema'] };
  }
  if (!isRecord(profile.model)) reasons.push('invalid-profile-model');
  for (const field of ['id', 'fingerprint', 'rigSignature']) {
    if (!profile.model || !profile.model[field]) reasons.push(`missing-model-${field}`);
    else if (Object.hasOwn(expectedModel, field) && !expectedModel[field]) reasons.push(`expected-model-${field}-unavailable`);
    else if (expectedModel[field] && profile.model[field] !== expectedModel[field]) reasons.push(`model-${field}-mismatch`);
  }
  if (typeof expectedCoreVersion !== 'string' || !expectedCoreVersion.trim() ||
      profile.coreVersion !== expectedCoreVersion) {
    reasons.push('core-version-mismatch');
  }
  if (!validateProfileMappings(profile.mappings) ||
      !isRecord(profile.parameters) || !isRecord(profile.transitions) ||
      !Array.isArray(profile.results) || !Number.isInteger(profile.calibrationVersion) ||
      profile.calibrationVersion < 1 || !Number.isFinite(Date.parse(profile.createdAt))) {
    reasons.push('invalid-profile-content');
  }
  const content = validateCalibrationParameters(profile);
  for (const reason of content.reasons) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return { ok: reasons.length === 0, compatible: reasons.length === 0, reasons };
}

export function parseCalibrationProfileJSON(serialized, expectedModel = {}, expectedCoreVersion = AVATAR_CORE_VERSION) {
  if (typeof serialized !== 'string') {
    return { ok: false, error: 'invalid-profile-json' };
  }
  let profile;
  try {
    profile = JSON.parse(serialized);
  } catch {
    return { ok: false, error: 'invalid-profile-json' };
  }
  const validation = validateCalibrationProfile(profile, expectedModel, expectedCoreVersion);
  return validation.ok
    ? { ok: true, profile, validation }
    : { ok: false, error: 'profile-incompatible', validation };
}
