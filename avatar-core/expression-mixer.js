import { FacialComposer, normalizeVisemeName } from './facial-composer.js';
import {
  AVATAR_CORE_VERSION,
  createCalibrationProfile,
  validateCalibrationProfile,
} from './calibration-profile.js';

const freezeProfile = (profile) => Object.freeze(profile);

export const EMOTION_PROFILES = Object.freeze({
  neutre: freezeProfile({}),
  joie: freezeProfile({
    mouthSmileLeft: 0.5,
    mouthSmileRight: 0.5,
    cheekSquintLeft: 0.24,
    cheekSquintRight: 0.24,
    browInnerUp: 0.06,
  }),
  tristesse: freezeProfile({
    browInnerUp: 0.32,
    mouthFrownLeft: 0.3,
    mouthFrownRight: 0.3,
    eyeSquintLeft: 0.08,
    eyeSquintRight: 0.08,
  }),
  colere: freezeProfile({
    browDownLeft: 0.4,
    browDownRight: 0.4,
    eyeSquintLeft: 0.2,
    eyeSquintRight: 0.2,
    mouthFrownLeft: 0.1,
    mouthFrownRight: 0.1,
  }),
  surprise: freezeProfile({
    eyeWideLeft: 0.48,
    eyeWideRight: 0.48,
    browOuterUpLeft: 0.35,
    browOuterUpRight: 0.35,
    browInnerUp: 0.14,
  }),
  // Peur : sourcils relevés et rapprochés, yeux écarquillés, bouche étirée.
  // Aucun morph de mâchoire ni de phonème -> jamais de conflit avec le lipsync.
  peur: freezeProfile({
    browInnerUp: 0.5,
    browOuterUpLeft: 0.14,
    browOuterUpRight: 0.14,
    eyeWideLeft: 0.42,
    eyeWideRight: 0.42,
    mouthStretchLeft: 0.3,
    mouthStretchRight: 0.3,
  }),
  // Dégoût : nez froncé, lèvre supérieure relevée, regard légèrement plissé.
  degout: freezeProfile({
    noseSneerLeft: 0.42,
    noseSneerRight: 0.42,
    mouthUpperUpLeft: 0.3,
    mouthUpperUpRight: 0.3,
    browDownLeft: 0.16,
    browDownRight: 0.16,
    eyeSquintLeft: 0.12,
    eyeSquintRight: 0.12,
  }),
  tendresse: freezeProfile({
    mouthSmileLeft: 0.22,
    mouthSmileRight: 0.22,
    cheekSquintLeft: 0.2,
    cheekSquintRight: 0.2,
    browInnerUp: 0.12,
    eyeSquintLeft: 0.05,
    eyeSquintRight: 0.05,
  }),
  concentration: freezeProfile({
    browDownLeft: 0.22,
    browDownRight: 0.22,
    eyeSquintLeft: 0.18,
    eyeSquintRight: 0.18,
    browInnerUp: 0.05,
  }),
});

export const EMOTION_NAMES = Object.freeze(Object.keys(EMOTION_PROFILES));

const EMOTION_ALIASES = Object.freeze({
  heureux: 'joie',
  happy: 'joie',
  triste: 'tristesse',
  sad: 'tristesse',
  fache: 'colere',
  angry: 'colere',
  fear: 'peur',
  scared: 'peur',
  afraid: 'peur',
  disgust: 'degout',
  disgusted: 'degout',
  degout: 'degout',
  surprised: 'surprise',
  tender: 'tendresse',
  focused: 'concentration',
  neutral: 'neutre',
  joy: 'joie',
  sadness: 'tristesse',
  anger: 'colere',
  tenderness: 'tendresse',
});

export function normalizeEmotionName(name) {
  const key = String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return EMOTION_ALIASES[key] || key;
}

function boundedWeight(value) {
  return Math.max(0, Math.min(1.5, Number(value) || 0));
}

function collectTargetNames(adapter) {
  if (!adapter || typeof adapter.getAvailableExpressionTargets !== 'function') return null;
  const available = adapter.getAvailableExpressionTargets();
  if (available == null) return null;
  if (typeof available[Symbol.iterator] === 'function') return new Set(available);

  const names = [
    ...(available.morphTargets || []),
    ...(available.customExpressions || []),
    ...(available.standardExpressions || []),
  ];
  return new Set(names);
}

/**
 * Pure expression profile mixer. It returns named morph contributions and
 * deliberately does not know about Three.js, VRM, rendering, or audio.
 */
export class ExpressionMixer {
  constructor() {
    this.current = Object.fromEntries(EMOTION_NAMES.map((name) => [name, name === 'neutre' ? 1 : 0]));
    this.target = { ...this.current };
    this.speed = 5.5;
    this.transitionScale = 1;
    this.calibration = Object.fromEntries(EMOTION_NAMES.map((name) => [name, 1]));
  }

  setEmotionMix(mix = {}, duration = 420) {
    const clean = Object.fromEntries(EMOTION_NAMES.map((name) => [name, boundedWeight(mix[name])]));
    if (!Object.values(clean).some((value) => value > 0)) clean.neutre = 1;
    this.target = clean;
    this.speed = 1000 / Math.max(80, (Number(duration) || 420) * this.transitionScale);
    return true;
  }

  setEmotion(name, intensity = 1, duration = 420) {
    const normalized = normalizeEmotionName(name);
    if (!Object.hasOwn(EMOTION_PROFILES, normalized)) return false;
    return this.setEmotionMix({ [normalized]: boundedWeight(intensity) }, duration);
  }

  resetExpression(duration = 420) {
    return this.setEmotionMix({ neutre: 1 }, duration);
  }

  update(deltaSeconds) {
    const dt = Math.max(0, Number(deltaSeconds) || 0);
    for (const name of EMOTION_NAMES) {
      const target = this.target[name] || 0;
      this.current[name] += (target - this.current[name]) * (1 - Math.exp(-dt * this.speed));
      if (Math.abs(target - this.current[name]) < 0.001) this.current[name] = target;
    }

    const contributions = {};
    for (const [name, profile] of Object.entries(EMOTION_PROFILES)) {
      const weight = this.current[name] || 0;
      if (weight <= 0.001) continue;
      for (const [target, value] of Object.entries(profile)) {
        contributions[target] = (contributions[target] || 0) + value * weight * this.calibration[name];
      }
    }
    return contributions;
  }

  getCurrentWeights() {
    return { ...this.current };
  }

  getTargetWeights() {
    return { ...this.target };
  }

  setCalibration(parameters = {}) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      return { ok: false, error: 'invalid-calibration-parameters' };
    }
    const next = { ...this.calibration };
    for (const [name, value] of Object.entries(parameters)) {
      if (!Object.hasOwn(next, name)) return { ok: false, error: 'unsupported-emotion-calibration' };
      if (!Number.isFinite(value)) return { ok: false, error: 'invalid-emotion-calibration' };
      next[name] = Math.max(0.8, Math.min(1.2, value));
    }
    this.calibration = next;
    return { ok: true, parameters: { ...this.calibration } };
  }

  getCalibration() {
    return { ...this.calibration };
  }

  getEmotionState() {
    return { current: { ...this.current }, target: { ...this.target } };
  }

  setTransitionScale(value) {
    if (!Number.isFinite(value)) return { ok: false, error: 'invalid-emotion-transition-scale' };
    this.transitionScale = Math.max(0.8, Math.min(1.2, value));
    return { ok: true, value: this.transitionScale };
  }
}

/**
 * @typedef {Object} AvatarAdapter
 * @property {() => boolean} [isLoaded] Whether an avatar is ready for commands.
 * @property {() => Iterable<string>|{
 *   morphTargets?: Iterable<string>,
 *   customExpressions?: Iterable<string>,
 *   standardExpressions?: Iterable<string>
 * }} [getAvailableExpressionTargets] Names supported by a direct-morph or VRM expression adapter.
 * @property {(source: unknown, options?: object) => unknown|Promise<unknown>} [loadAvatar]
 * @property {() => void} [clearMorphWeights] Revert the previously applied facial layer before the next render update.
 * @property {() => {leftEye?: boolean, rightEye?: boolean, lookAt?: boolean}} [getGazeCapabilities]
 * @property {() => {left?: boolean, right?: boolean}} [getBlinkCapabilities]
 * @property {(gaze: {x: number, y: number}, options: {overrideLookAt: 'block'}) => void} [applyGaze]
 * @property {(weights: Object<string, number>, options: {visemes: Object<string, number>, overrideMouth: 'block', overrideBlink: 'block', overrideLookAt: 'block'}) => void} [applyMorphWeights]
 *
 * A VRM 1.0 expression-manager adapter receives canonical visemes and the
 * `overrideMouth: 'block'` policy with composed weights. Direct-morph adapters
 * remain supported and do not require the expression manager.
 */
export class AvatarCore {
  constructor({ adapter = null, mixer = new ExpressionMixer(), composer = new FacialComposer() } = {}) {
    this.adapter = adapter;
    this.mixer = mixer;
    this.composer = composer;
    this.disposed = false;
    this.snapshotFrame = 0;
    this.lastComposedWeights = {};
    this.lastAppliedWeights = {};
    this.morphStableFrames = 0;
    this.renderStableFrames = 0;
    this.lastRenderedWeights = {};
    this.secondaryMotionSnapshot = null;
  }

  async loadAvatar(source, options) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    if (!this.adapter || typeof this.adapter.loadAvatar !== 'function') {
      return { ok: false, error: 'avatar-loader-not-configured' };
    }
    const result = await this.adapter.loadAvatar(source, options);
    return result && typeof result === 'object' ? result : { ok: true, avatar: result };
  }

  setEmotion(name, intensity = 1, duration = 420) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    const emotion = normalizeEmotionName(name);
    if (!Object.hasOwn(EMOTION_PROFILES, emotion)) {
      return { ok: false, emotion, error: 'unknown-emotion' };
    }
    if (this.adapter && typeof this.adapter.isLoaded === 'function' && !this.adapter.isLoaded()) {
      return { ok: false, emotion, intensity: Number(intensity) || 0, error: 'avatar-not-loaded' };
    }

    const profile = EMOTION_PROFILES[emotion];
    const availableTargets = collectTargetNames(this.adapter);
    const morphTargets = availableTargets
      ? Object.keys(profile).filter((target) => availableTargets.has(target))
      : Object.keys(profile);
    if (emotion !== 'neutre' && availableTargets && !morphTargets.length) {
      return { ok: false, emotion, error: 'emotion-targets-unavailable' };
    }

    const strength = boundedWeight(intensity);
    this.mixer.setEmotion(emotion, strength, duration);
    return {
      ok: true,
      emotion,
      intensity: strength,
      duration: Number(duration) || 420,
      morphTargets,
    };
  }

  setEmotionMix(mix, duration = 420) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    return this.mixer.setEmotionMix(mix, duration);
  }

  setViseme(name, intensity, duration) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    const viseme = normalizeVisemeName(name);
    if (!viseme) return { ok: false, error: 'unknown-viseme' };
    const morphTargets = this.composer.getVisemeTargets(viseme);
    const availableTargets = collectTargetNames(this.adapter);
    if (!['P', 'F'].includes(viseme) && availableTargets &&
        !morphTargets.some((target) => availableTargets.has(target))) {
      return { ok: false, viseme, error: 'viseme-targets-unavailable', morphTargets };
    }
    return this.composer.setViseme(name, intensity, duration);
  }

  setVisemeMapping(mapping) {
    return this.composer.setVisemeMapping(mapping);
  }

  setVisemeContributions(weights) {
    return this.composer.setVisemeContributions(weights);
  }

  resetViseme(duration) {
    return this.composer.resetViseme(duration);
  }

  setJawOpen(intensity) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    return this.composer.setJawOpen(intensity);
  }

  setSupplementalMorphWeights(weights) {
    return this.composer.setSupplementalMorphWeights(weights);
  }

  setSpeechAmount(amount) {
    return this.composer.setSpeechAmount(amount);
  }

  setGaze(x, y) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    if (!this.hasGazeControl()) {
      return { ok: false, error: 'gaze-unavailable' };
    }
    return this.composer.setGaze(x, y);
  }

  setGazeTarget(target) {
    if (!this.hasGazeControl()) {
      return { ok: false, error: 'gaze-unavailable' };
    }
    return this.composer.setGazeTarget(target);
  }

  resetGaze() {
    if (!this.hasGazeControl()) return { ok: false, error: 'gaze-unavailable' };
    return this.composer.resetGaze();
  }

  setNaturalGaze(enabled) {
    if (enabled && !this.hasGazeControl()) {
      return { ok: false, error: 'gaze-unavailable' };
    }
    return this.composer.setNaturalGaze(enabled);
  }

  hasGazeControl() {
    const capabilities = this.getGazeCapabilities();
    if (capabilities.leftEye || capabilities.rightEye || capabilities.lookAt) return true;
    const targets = this.composer.getGazeTargets();
    if (!targets.length || !this.adapter || typeof this.adapter.applyMorphWeights !== 'function') return false;
    const availableTargets = collectTargetNames(this.adapter);
    return !availableTargets || targets.some((target) => availableTargets.has(target));
  }

  setGazeMapping(mapping) {
    return this.composer.setGazeMapping(mapping);
  }

  getGazeCapabilities() {
    if (!this.adapter || typeof this.adapter.getGazeCapabilities !== 'function') {
      return { leftEye: false, rightEye: false, lookAt: false };
    }
    return this.adapter.getGazeCapabilities() || {};
  }

  clearMorphWeights() {
    if (this.adapter && typeof this.adapter.clearMorphWeights === 'function') {
      this.adapter.clearMorphWeights();
    }
  }

  getBlinkCapabilities() {
    if (!this.adapter || typeof this.adapter.getBlinkCapabilities !== 'function') {
      return { left: false, right: false };
    }
    return this.adapter.getBlinkCapabilities() || {};
  }

  setBlink(intensity, side = 'both') {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    const capabilities = this.getBlinkCapabilities();
    if (side === 'left' && !capabilities.left) return { ok: false, error: 'left-blink-unavailable' };
    if (side === 'right' && !capabilities.right) return { ok: false, error: 'right-blink-unavailable' };
    if (side === 'both' && !capabilities.left && !capabilities.right) {
      return { ok: false, error: 'blink-unavailable' };
    }
    return this.composer.setBlink(intensity, side);
  }

  triggerBlink(intensity = 1, side = 'both') {
    const capabilities = this.getBlinkCapabilities();
    if (side === 'left' && !capabilities.left) return { ok: false, error: 'left-blink-unavailable' };
    if (side === 'right' && !capabilities.right) return { ok: false, error: 'right-blink-unavailable' };
    if (side === 'both' && !capabilities.left && !capabilities.right) {
      return { ok: false, error: 'blink-unavailable' };
    }
    return this.composer.triggerBlink(intensity, side);
  }

  setAutoBlink(enabled) {
    if (enabled) {
      const capabilities = this.getBlinkCapabilities();
      if (!capabilities.left && !capabilities.right) return { ok: false, error: 'blink-unavailable' };
    }
    return this.composer.setAutoBlink(enabled);
  }

  setBlinkOptions(options) {
    return this.composer.setBlinkOptions(options);
  }

  setBlinkMapping(mapping) {
    return this.composer.setBlinkMapping(mapping);
  }

  resetBlink() {
    const capabilities = this.getBlinkCapabilities();
    if (!capabilities.left && !capabilities.right) return { ok: false, error: 'blink-unavailable' };
    return this.composer.resetBlink();
  }

  getBlinkWeights() {
    return this.composer.getBlinkWeights();
  }

  getBehaviorSettings() {
    return {
      autoBlink: this.composer.autoBlinkEnabled,
      naturalGaze: this.composer.naturalGazeEnabled,
    };
  }

  resetBehavior() {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    this.mixer.resetExpression();
    this.composer.resetBehavior();
    return { ok: true };
  }

  resetExpression(duration = 420) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    this.mixer.resetExpression(duration);
    return { ok: true, emotion: 'neutre', duration: Number(duration) || 420 };
  }

  applyCalibration(profileOrParameters) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    const isVersionedProfile = profileOrParameters?.schema != null ||
      profileOrParameters?.schemaVersion != null || profileOrParameters?.coreVersion != null;
    if (isVersionedProfile) {
      const model = this.getModelIdentity();
      if (!['id', 'fingerprint', 'rigSignature'].every((field) => model[field])) {
        return { ok: false, error: 'model-identity-unavailable' };
      }
      const validation = validateCalibrationProfile(profileOrParameters, model, AVATAR_CORE_VERSION);
      if (!validation.compatible) {
        return { ok: false, error: 'profile-incompatible', reasons: validation.reasons };
      }
    }
    const parameters = profileOrParameters?.parameters || profileOrParameters;
    const transitions = profileOrParameters?.parameters ? profileOrParameters.transitions : null;
    const mappings = profileOrParameters?.parameters ? profileOrParameters.mappings : null;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      return { ok: false, error: 'invalid-calibration-profile' };
    }
    const emotionScales = parameters.emotionScales || {};
    if (!emotionScales || typeof emotionScales !== 'object' || Array.isArray(emotionScales) ||
        Object.entries(emotionScales).some(([name, value]) => !Object.hasOwn(EMOTION_PROFILES, name) || !Number.isFinite(value))) {
      return { ok: false, error: 'invalid-emotion-calibration' };
    }
    const supported = new Set(['emotionScales', 'visemeScales', 'jawScale', 'gazeScale', 'blinkScale']);
    if (Object.keys(parameters).some((name) => !supported.has(name))) {
      return { ok: false, error: 'unsupported-calibration-parameter' };
    }
    if (transitions != null) {
      if (!transitions || typeof transitions !== 'object' || Array.isArray(transitions)) {
        return { ok: false, error: 'invalid-transition-calibration' };
      }
      const ranges = {
        emotionScale: [0.8, 1.2], visemeScale: [0.8, 1.2],
        gazeSmoothingScale: [0.8, 1.2], blinkDurationScale: [0.8, 1.2],
      };
      if (Object.entries(transitions).some(([name, value]) =>
        !Object.hasOwn(ranges, name) || !Number.isFinite(value) || value < ranges[name][0] || value > ranges[name][1])) {
        return { ok: false, error: 'invalid-transition-calibration' };
      }
    }
    let validatedMappings = null;
    if (mappings != null) {
      if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings) ||
         Object.keys(mappings).some((name) => !['visemes', 'legacyVisemes', 'gaze', 'blink'].includes(name))) {
        return { ok: false, error: 'invalid-calibration-mappings' };
      }
      const validator = new FacialComposer();
      const mappingResults = [
        ['visemes', validator.setVisemeMapping.bind(validator)],
        ['legacyVisemes', validator.setVisemeMapping.bind(validator)],
        ['gaze', validator.setGazeMapping.bind(validator)],
        ['blink', validator.setBlinkMapping.bind(validator)],
      ];
      for (const [name, validate] of mappingResults) {
        if (mappings[name] == null) continue;
        const mapping = mappings[name];
        if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
           Object.values(mapping).some((weights) =>
             !weights || typeof weights !== 'object' || Array.isArray(weights) ||
             Object.values(weights).some((weight) =>
               !Number.isFinite(weight) || weight < 0 || weight > 1.5))) {
         return { ok: false, error: 'invalid-calibration-mappings' };
        }
        const result = validate(mapping);
        if (!result.ok) return { ok: false, error: result.error || 'invalid-calibration-mappings' };
      }
      validatedMappings = mappings;
    }
    const facialResult = this.composer.setCalibration(parameters);
    if (!facialResult.ok) return facialResult;
    const emotionResult = this.mixer.setCalibration(emotionScales);
    if (!emotionResult.ok) return emotionResult;
    if (transitions) {
      this.mixer.setTransitionScale(transitions.emotionScale ?? 1);
      const transitionResult = this.composer.setTransitionCalibration(transitions);
      if (!transitionResult.ok) return transitionResult;
    }
    if (validatedMappings) {
      if (validatedMappings.visemes || validatedMappings.legacyVisemes) {
        this.composer.setVisemeMapping({
          ...validatedMappings.visemes,
          ...validatedMappings.legacyVisemes,
        });
      }
      if (validatedMappings.gaze) this.composer.setGazeMapping(validatedMappings.gaze);
      if (validatedMappings.blink) this.composer.setBlinkMapping(validatedMappings.blink);
    }
    const calibration = this.exportCalibration();
    return {
      ok: true,
      parameters: calibration.parameters,
      transitions: calibration.transitions,
      mappings: calibration.mappings,
    };
  }

  exportCalibration() {
    const calibration = {
      ok: true,
      parameters: {
        emotionScales: this.mixer.getCalibration(),
        ...this.composer.getCalibration(),
      },
      transitions: {
        emotionScale: this.mixer.transitionScale,
        ...this.composer.getTransitionCalibration(),
      },
      mappings: {
        visemes: structuredClone(this.composer.visemeMapping),
        gaze: structuredClone(this.composer.gazeMapping),
        blink: structuredClone(this.composer.blinkMapping),
      },
    };
    const model = this.getModelIdentity();
    if (['id', 'fingerprint', 'rigSignature'].every((field) => model[field])) {
      return {
        ...calibration,
        ...createCalibrationProfile({
          model,
          mappings: calibration.mappings,
          parameters: calibration.parameters,
          transitions: calibration.transitions,
        }),
      };
    }
    return calibration;
  }

  exportCalibrationProfile({ model = this.getModelIdentity(), results = [] } = {}) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    if (!['id', 'fingerprint', 'rigSignature'].every((field) => model?.[field])) {
      return { ok: false, error: 'model-identity-unavailable' };
    }
    const calibration = this.exportCalibration();
    return {
      ok: true,
      profile: createCalibrationProfile({
        model,
        mappings: calibration.mappings,
        parameters: calibration.parameters,
        transitions: calibration.transitions,
        results,
      }),
    };
  }

  getModelIdentity() {
    if (!this.adapter || typeof this.adapter.getModelIdentity !== 'function') return {};
    return this.adapter.getModelIdentity() || {};
  }

  setModelIdentity(identity) {
    if (this.disposed) return { ok: false, error: 'core-disposed' };
    if (!this.adapter || typeof this.adapter.setModelIdentity !== 'function') {
      return { ok: false, error: 'model-identity-not-supported' };
    }
    return this.adapter.setModelIdentity(identity);
  }

  dispose() {
    if (this.disposed) return { ok: true };
    this.resetBehavior();
    this.clearMorphWeights();
    if (this.adapter && typeof this.adapter.dispose === 'function') this.adapter.dispose();
    this.adapter = null;
    this.disposed = true;
    return { ok: true };
  }

  update(deltaSeconds) {
    if (this.disposed) throw new Error('core-disposed');
    const weights = this.composer.update(deltaSeconds, this.mixer.update(deltaSeconds));
    if (this.adapter && typeof this.adapter.applyGaze === 'function') {
      const capabilities = this.getGazeCapabilities();
      if (capabilities.leftEye || capabilities.rightEye || capabilities.lookAt) {
        this.adapter.applyGaze(this.composer.getGaze(), { overrideLookAt: 'block' });
      }
    }
    if (this.adapter && typeof this.adapter.applyMorphWeights === 'function') {
      const gazeTargets = this.composer.getGazeTargets();
      this.adapter.applyMorphWeights(weights, {
        visemes: this.composer.getCurrentVisemes(),
        overrideMouth: 'block',
        overrideBlink: 'block',
        overrideLookAt: 'block',
        gazeTargets,
      });
    }
    const adapterWeights = typeof this.adapter?.getAppliedWeights === 'function'
      ? this.adapter.getAppliedWeights()
      : weights;
    const appliedWeights = adapterWeights && typeof adapterWeights === 'object'
      ? { ...adapterWeights }
      : {};
    const morphStable = this.weightsWithinTolerance(appliedWeights, this.lastAppliedWeights, 0.001) &&
      this.weightsWithinTolerance(appliedWeights, weights, 0.001);
    this.morphStableFrames = morphStable ? this.morphStableFrames + 1 : 0;
    if (!this.weightsWithinTolerance(appliedWeights, this.lastRenderedWeights, 0.001)) this.renderStableFrames = 0;
    this.lastComposedWeights = { ...weights };
    this.lastAppliedWeights = appliedWeights;
    this.snapshotFrame += 1;
    return weights;
  }

  weightsWithinTolerance(left, right, tolerance = 0.001) {
    const names = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
    for (const name of names) {
      if (Math.abs(Number(left?.[name] || 0) - Number(right?.[name] || 0)) > tolerance) return false;
    }
    return true;
  }

  markFrameRendered() {
    if (this.weightsWithinTolerance(this.lastAppliedWeights, this.lastRenderedWeights, 0.001)) {
      this.renderStableFrames += 1;
    } else {
      this.renderStableFrames = 1;
    }
    this.lastRenderedWeights = { ...this.lastAppliedWeights };
    return this.renderStableFrames;
  }

  getConvergence(options = {}) {
    const stableFrames = Math.max(2, Number(options.stableFrames) || 2);
    const emotionState = this.mixer.getEmotionState();
    const mixerConverged = EMOTION_NAMES.every((name) =>
      Math.abs((emotionState.current[name] || 0) - (emotionState.target[name] || 0)) < 0.001);
    const visemeConverged = Object.keys(this.composer.currentVisemes).every((name) =>
      Math.abs((this.composer.currentVisemes[name] || 0) - (this.composer.targetVisemes[name] || 0)) < 0.001);
    const gazeConverged = this.composer.naturalGazeEnabled ||
      (Math.abs(this.composer.gaze.x - this.composer.gazeTarget.x) < 0.001 &&
      Math.abs(this.composer.gaze.y - this.composer.gazeTarget.y) < 0.001);
    const blinkConverged = this.composer.blinkElapsed == null &&
      this.weightsWithinTolerance(this.composer.manualBlink, this.composer.manualBlinkTarget, 0.001);
    const composerConverged = visemeConverged && gazeConverged && blinkConverged;
    const morphsApplied = this.weightsWithinTolerance(this.lastAppliedWeights, this.lastComposedWeights, 0.001);
    const morphsStable = morphsApplied && this.morphStableFrames >= stableFrames;
    const renderingStable = morphsStable && this.renderStableFrames >= stableFrames;
    return Object.freeze({
      mixerConverged,
      composerConverged,
      morphsApplied,
      morphsStable,
      renderingStable,
      captureAllowed: mixerConverged && composerConverged && morphsStable && renderingStable,
      stableFrames: this.renderStableFrames,
    });
  }

  getSnapshot() {
    const emotionState = this.mixer.getEmotionState();
    const visemeEntries = Object.entries(this.composer.currentVisemes)
      .filter(([, intensity]) => intensity > 0.001)
      .sort((left, right) => right[1] - left[1]);
    const [viseme = null, visemeIntensity = 0] = visemeEntries[0] || [];
    return Object.freeze({
      emotions: Object.freeze({ ...emotionState.current }),
      emotionTargets: Object.freeze({ ...emotionState.target }),
      viseme: viseme,
      visemeIntensity,
      jawOpen: this.composer.jawOpen,
      gaze: Object.freeze({ ...this.composer.gaze }),
      gazeTarget: Object.freeze({ ...this.composer.gazeTarget }),
      blink: Object.freeze({ ...this.composer.currentBlink }),
      composedMorphWeights: Object.freeze({ ...this.lastComposedWeights }),
      appliedMorphWeights: Object.freeze({ ...this.lastAppliedWeights }),
      convergence: this.getConvergence(),
      secondaryMotion: Object.freeze({
        ...(this.getBehaviorSettings()),
        frozen: this.secondaryMotionSnapshot != null,
      }),
      timestamp: Date.now(),
      frame: this.snapshotFrame,
    });
  }

  freezeSecondaryMotion() {
    if (this.secondaryMotionSnapshot == null) {
      this.secondaryMotionSnapshot = {
        autoBlink: this.composer.autoBlinkEnabled,
        naturalGaze: this.composer.naturalGazeEnabled,
      };
      this.composer.setAutoBlink(false);
      this.composer.setNaturalGaze(false);
      this.renderStableFrames = 0;
    }
    return this.getBehaviorSettings();
  }

  restoreSecondaryMotion() {
    if (this.secondaryMotionSnapshot == null) return this.getBehaviorSettings();
    const { autoBlink, naturalGaze } = this.secondaryMotionSnapshot;
    this.composer.setAutoBlink(autoBlink);
    this.composer.setNaturalGaze(naturalGaze);
    this.secondaryMotionSnapshot = null;
    this.renderStableFrames = 0;
    return this.getBehaviorSettings();
  }

  inspectMorphWeights() {
    return this.composer.inspectMorphWeights();
  }

  getEmotionState() {
    return this.mixer.getEmotionState();
  }

  getCurrentEmotionWeights() {
    return this.mixer.getCurrentWeights();
  }
}

export function createAvatarCore(options) {
  return new AvatarCore(options);
}
