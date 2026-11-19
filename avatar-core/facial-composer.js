export const VISEME_NAMES = Object.freeze(['AA', 'IH', 'OU', 'EE', 'OH', 'P', 'F']);

export const VISEME_ALIASES = Object.freeze({
  A: 'AA',
  I: 'IH',
  U: 'OU',
  E: 'EE',
  O: 'OH',
  AA: 'AA',
  IH: 'IH',
  OU: 'OU',
  EE: 'EE',
  OH: 'OH',
  P: 'P',
  F: 'F',
});

export const DEFAULT_VISEME_MAPPING = Object.freeze({
  AA: Object.freeze({ aa: 1 }),
  IH: Object.freeze({ ih: 1 }),
  OU: Object.freeze({ ou: 1 }),
  EE: Object.freeze({ ee: 1 }),
  OH: Object.freeze({ oh: 1 }),
  P: Object.freeze({}),
  F: Object.freeze({}),
});

export const DEFAULT_BLINK_MAPPING = Object.freeze({
  left: Object.freeze({ eyeBlinkLeft: 1 }),
  right: Object.freeze({ eyeBlinkRight: 1 }),
});

export const DEFAULT_GAZE_MAPPING = Object.freeze({
  left: Object.freeze({}),
  right: Object.freeze({}),
  up: Object.freeze({}),
  down: Object.freeze({}),
});

const boundedIntensity = (value) => Math.max(0, Math.min(1.5, Number(value) || 0));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function normalizeVisemeName(name) {
  const key = String(name || '').trim().toUpperCase();
  return VISEME_ALIASES[key] || null;
}

function cleanMorphWeights(weights = {}) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return {};
  return Object.fromEntries(
    Object.entries(weights)
      .filter(([name, value]) => typeof name === 'string' && Number.isFinite(Number(value)))
      .map(([name, value]) => [name, boundedIntensity(value)])
      .filter(([, value]) => value > 0),
  );
}

export class FacialComposer {
  constructor({
    visemeMapping = DEFAULT_VISEME_MAPPING,
    blinkMapping = DEFAULT_BLINK_MAPPING,
    gazeMapping = DEFAULT_GAZE_MAPPING,
    random = Math.random,
    gazeSmoothingSeconds = 0.14,
    maxGazeX = 0.0425,
    maxGazeY = 0.025,
    blinkDurationMs = 130,
    blinkIntervalMs = [2300, 5600],
    doubleBlinkChance = 0.14,
    doubleBlinkIntervalMs = [320, 500],
    blinkRightOffsetMs = 14,
  } = {}) {
    this.visemeMapping = { ...visemeMapping };
    this.blinkMapping = { ...blinkMapping };
    this.gazeMapping = { ...gazeMapping };
    this.currentVisemes = Object.fromEntries(VISEME_NAMES.map((name) => [name, 0]));
    this.targetVisemes = { ...this.currentVisemes };
    this.visemeSpeed = 1000 / 80;
    this.directVisemeWeights = {};
    this.supplementalWeights = {};
    this.jawOpen = 0;
    this.speechAmount = 0;
    this.lastMorphWeights = {};
    this.random = random;
    this.gazeSmoothingSeconds = Math.max(0.001, Number(gazeSmoothingSeconds) || 0.14);
    this.maxGazeX = Math.max(0, Number(maxGazeX) || 0);
    this.maxGazeY = Math.max(0, Number(maxGazeY) || 0);
    this.gaze = { x: 0, y: 0 };
    this.gazeTarget = { x: 0, y: 0 };
    this.naturalGazeEnabled = false;
    this.gazeElapsed = 0;
    this.nextGazeChange = this.randomBetween(0.6, 1.5);
    this.elapsed = 0;
    this.blinkDurationMs = Math.max(40, Number(blinkDurationMs) || 130);
    this.blinkIntervalMs = this.validRange(blinkIntervalMs, [2300, 5600]);
    this.doubleBlinkChance = clamp(Number(doubleBlinkChance) || 0, 0, 1);
    this.doubleBlinkIntervalMs = this.validRange(doubleBlinkIntervalMs, [320, 500]);
    this.blinkRightOffsetMs = Math.max(0, Number(blinkRightOffsetMs) || 0);
    this.autoBlinkEnabled = false;
    this.nextAutoBlink = this.randomBetween(...this.blinkIntervalMs) / 1000;
    this.blinkElapsed = null;
    this.manualBlink = { left: 0, right: 0 };
    this.manualBlinkTarget = { left: 0, right: 0 };
    this.triggerSide = 'both';
    this.currentBlink = { left: 0, right: 0 };
    this.calibration = {
      visemeScales: Object.fromEntries(VISEME_NAMES.map((name) => [name, 1])),
      jawScale: 1,
      gazeScale: 1,
      blinkScale: 1,
    };
    this.transitionCalibration = { emotionScale: 1, visemeScale: 1, gazeSmoothingScale: 1, blinkDurationScale: 1 };
  }

  randomBetween(min, max) {
    return min + this.random() * (max - min);
  }

  validRange(range, fallback) {
    if (!Array.isArray(range) || range.length !== 2 ||
        !Number.isFinite(Number(range[0])) || !Number.isFinite(Number(range[1])) ||
        Number(range[0]) < 1 || Number(range[1]) < Number(range[0])) return fallback;
    return [Number(range[0]), Number(range[1])];
  }

  setVisemeMapping(mapping = {}) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      return { ok: false, error: 'invalid-viseme-mapping' };
    }
    const next = { ...this.visemeMapping };
    for (const [rawName, weights] of Object.entries(mapping)) {
      const name = normalizeVisemeName(rawName);
      if (!name || !weights || typeof weights !== 'object' || Array.isArray(weights)) {
        return { ok: false, error: 'invalid-viseme-mapping' };
      }
      next[name] = cleanMorphWeights(weights);
    }
    this.visemeMapping = next;
    return { ok: true, mapping: { ...this.visemeMapping } };
  }

  setBlinkMapping(mapping = {}) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      return { ok: false, error: 'invalid-blink-mapping' };
    }
    const next = { ...this.blinkMapping };
    for (const [side, weights] of Object.entries(mapping)) {
      if (!['left', 'right'].includes(side) || !weights || typeof weights !== 'object' || Array.isArray(weights)) {
        return { ok: false, error: 'invalid-blink-mapping' };
      }
      next[side] = cleanMorphWeights(weights);
    }
    this.blinkMapping = next;
    return { ok: true, mapping: { ...this.blinkMapping } };
  }

  setGazeMapping(mapping = {}) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      return { ok: false, error: 'invalid-gaze-mapping' };
    }
    const next = { ...this.gazeMapping };
    for (const [direction, weights] of Object.entries(mapping)) {
      if (!['left', 'right', 'up', 'down'].includes(direction) ||
          !weights || typeof weights !== 'object' || Array.isArray(weights)) {
        return { ok: false, error: 'invalid-gaze-mapping' };
      }
      next[direction] = cleanMorphWeights(weights);
    }
    this.gazeMapping = next;
    return { ok: true, mapping: { ...this.gazeMapping } };
  }

  setGaze(x, y) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
      return { ok: false, error: 'invalid-gaze-target' };
    }
    this.naturalGazeEnabled = false;
    this.gazeTarget = { x: clamp(Number(x), -1, 1), y: clamp(Number(y), -1, 1) };
    return { ok: true, target: { ...this.gazeTarget } };
  }

  setGazeTarget(target) {
    const namedTargets = {
      center: [0, 0],
      left: [-1, 0],
      right: [1, 0],
      up: [0, 1],
      down: [0, -1],
    };
    const coordinates = typeof target === 'string'
      ? namedTargets[target.toLowerCase()]
      : target && [target.x, target.y];
    if (!coordinates) return { ok: false, error: 'invalid-gaze-target' };
    return this.setGaze(coordinates[0], coordinates[1]);
  }

  setNaturalGaze(enabled) {
    this.naturalGazeEnabled = !!enabled;
    this.gazeElapsed = 0;
    if (this.naturalGazeEnabled) this.nextGazeChange = this.randomBetween(0.6, 1.5);
    else this.gazeTarget = { x: 0, y: 0 };
    return { ok: true, enabled: this.naturalGazeEnabled };
  }

  resetGaze() {
    this.naturalGazeEnabled = false;
    this.gazeTarget = { x: 0, y: 0 };
    return { ok: true };
  }

  setBlink(intensity, side = 'both') {
    if (!Number.isFinite(Number(intensity))) return { ok: false, error: 'invalid-blink-intensity' };
    if (!['both', 'left', 'right'].includes(side)) return { ok: false, error: 'invalid-blink-side' };
    const strength = clamp(Number(intensity), 0, 1);
    if (side === 'both') this.manualBlinkTarget = { left: strength, right: strength };
    else this.manualBlinkTarget[side] = strength;
    return { ok: true, intensity: strength, side };
  }

  triggerBlink(intensity = 1, side = 'both') {
    if (!Number.isFinite(Number(intensity))) return { ok: false, error: 'invalid-blink-intensity' };
    if (!['both', 'left', 'right'].includes(side)) return { ok: false, error: 'invalid-blink-side' };
    this.blinkElapsed = 0;
    this.triggerIntensity = clamp(Number(intensity), 0, 1);
    this.triggerSide = side;
    return { ok: true, intensity: this.triggerIntensity };
  }

  setAutoBlink(enabled) {
    this.autoBlinkEnabled = !!enabled;
    this.nextAutoBlink = this.elapsed + this.randomBetween(...this.blinkIntervalMs) / 1000;
    return { ok: true, enabled: this.autoBlinkEnabled };
  }

  setBlinkOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      return { ok: false, error: 'invalid-blink-options' };
    }
    if (options.durationMs != null) {
      if (!Number.isFinite(Number(options.durationMs)) || Number(options.durationMs) < 40) {
        return { ok: false, error: 'invalid-blink-duration' };
      }
      this.blinkDurationMs = Number(options.durationMs);
    }
    if (options.intervalMs != null) {
      const range = this.validRange(options.intervalMs, null);
      if (!range) return { ok: false, error: 'invalid-blink-interval' };
      this.blinkIntervalMs = range;
    }
    if (options.doubleBlinkChance != null) {
      if (!Number.isFinite(Number(options.doubleBlinkChance))) return { ok: false, error: 'invalid-double-blink-chance' };
      this.doubleBlinkChance = clamp(Number(options.doubleBlinkChance), 0, 1);
    }
    if (options.doubleBlinkIntervalMs != null) {
      const range = this.validRange(options.doubleBlinkIntervalMs, null);
      if (!range) return { ok: false, error: 'invalid-double-blink-interval' };
      this.doubleBlinkIntervalMs = range;
    }
    if (options.rightOffsetMs != null) {
      if (!Number.isFinite(Number(options.rightOffsetMs)) || Number(options.rightOffsetMs) < 0) {
        return { ok: false, error: 'invalid-blink-offset' };
      }
      this.blinkRightOffsetMs = Number(options.rightOffsetMs);
    }
    if (this.autoBlinkEnabled) {
      this.nextAutoBlink = this.elapsed + this.randomBetween(...this.blinkIntervalMs) / 1000;
    }
    return { ok: true };
  }

  resetBlink() {
    this.manualBlink = { left: 0, right: 0 };
    this.manualBlinkTarget = { left: 0, right: 0 };
    this.blinkElapsed = null;
    this.currentBlink = { left: 0, right: 0 };
    return { ok: true };
  }

  resetBehavior() {
    this.resetGaze();
    this.resetBlink();
    this.resetViseme();
    this.setJawOpen(0);
    this.setSupplementalMorphWeights({});
    this.setSpeechAmount(0);
    this.gaze = { x: 0, y: 0 };
    this.gazeTarget = { x: 0, y: 0 };
    this.naturalGazeEnabled = false;
    this.autoBlinkEnabled = false;
    return { ok: true };
  }

  setViseme(name, intensity, duration = 80) {
    const viseme = normalizeVisemeName(name);
    if (!viseme) return { ok: false, error: 'unknown-viseme' };

    const strength = boundedIntensity(intensity);
    this.targetVisemes = Object.fromEntries(VISEME_NAMES.map((item) => [item, item === viseme ? strength : 0]));
    this.visemeSpeed = 1000 / Math.max(80, (Number(duration) || 80) * this.transitionCalibration.visemeScale);
    return {
      ok: true,
      viseme,
      intensity: strength,
      morphTargets: Object.keys(this.visemeMapping[viseme] || {}),
    };
  }

  setVisemeContributions(weights = {}) {
    this.directVisemeWeights = cleanMorphWeights(weights);
    return { ok: true };
  }

  resetViseme(duration = 80) {
    this.targetVisemes = Object.fromEntries(VISEME_NAMES.map((name) => [name, 0]));
    this.visemeSpeed = 1000 / Math.max(80, (Number(duration) || 80) * this.transitionCalibration.visemeScale);
    this.directVisemeWeights = {};
    return { ok: true, duration: Number(duration) || 80 };
  }

  setJawOpen(intensity) {
    this.jawOpen = boundedIntensity(intensity);
    return { ok: true, intensity: this.jawOpen };
  }

  setSupplementalMorphWeights(weights = {}) {
    this.supplementalWeights = cleanMorphWeights(weights);
    return { ok: true };
  }

  setSpeechAmount(amount) {
    this.speechAmount = Math.max(0, Number(amount) || 0);
    return { ok: true, amount: this.speechAmount };
  }

  setCalibration(parameters = {}) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      return { ok: false, error: 'invalid-calibration-parameters' };
    }
    const next = structuredClone(this.calibration);
    for (const [name, range] of [
      ['jawScale', [0.8, 1.2]],
      ['gazeScale', [0.8, 1.2]],
      ['blinkScale', [0.8, 1.2]],
    ]) {
      if (parameters[name] == null) continue;
      if (!Number.isFinite(parameters[name])) return { ok: false, error: `invalid-${name}` };
      next[name] = clamp(parameters[name], ...range);
    }
    if (parameters.visemeScales != null) {
      if (!parameters.visemeScales || typeof parameters.visemeScales !== 'object' || Array.isArray(parameters.visemeScales)) {
        return { ok: false, error: 'invalid-viseme-scales' };
      }
      for (const [name, value] of Object.entries(parameters.visemeScales)) {
        const viseme = normalizeVisemeName(name);
        if (!viseme || !Number.isFinite(value)) return { ok: false, error: 'invalid-viseme-scales' };
        next.visemeScales[viseme] = clamp(value, 0.8, 1.2);
      }
    }
    this.calibration = next;
    return { ok: true, parameters: structuredClone(next) };
  }

  getCalibration() {
    return structuredClone(this.calibration);
  }

  setTransitionCalibration(transitions = {}) {
    if (!transitions || typeof transitions !== 'object' || Array.isArray(transitions)) {
      return { ok: false, error: 'invalid-transition-calibration' };
    }
    const next = { ...this.transitionCalibration };
    for (const [name, value] of Object.entries(transitions)) {
      if (!Object.hasOwn(next, name)) return { ok: false, error: 'unsupported-transition-calibration' };
      if (!Number.isFinite(value)) return { ok: false, error: `invalid-${name}` };
      next[name] = clamp(value, 0.8, 1.2);
    }
    this.transitionCalibration = next;
    return { ok: true, transitions: structuredClone(next) };
  }

  getTransitionCalibration() {
    return structuredClone(this.transitionCalibration);
  }

  update(deltaSeconds, emotionWeights = {}) {
    const dt = Math.max(0, Number(deltaSeconds) || 0);
    this.elapsed += dt;
    if (this.naturalGazeEnabled) {
      this.gazeElapsed += dt;
      if (this.gazeElapsed >= this.nextGazeChange) {
        this.gazeTarget = {
          x: this.randomBetween(-1, 1),
          y: this.randomBetween(-1, 1),
        };
        this.gazeElapsed = 0;
        this.nextGazeChange = this.randomBetween(0.9, 2.8);
      }
    }
    const gazeFactor = 1 - Math.exp(-dt / (this.gazeSmoothingSeconds * this.transitionCalibration.gazeSmoothingScale));
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * gazeFactor;
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * gazeFactor;
    const blinkFactor = 1 - Math.exp(-dt / (0.06 * this.transitionCalibration.blinkDurationScale));
    for (const side of ['left', 'right']) {
      this.manualBlink[side] += (this.manualBlinkTarget[side] - this.manualBlink[side]) * blinkFactor;
      if (Math.abs(this.manualBlinkTarget[side] - this.manualBlink[side]) < 0.001) {
        this.manualBlink[side] = this.manualBlinkTarget[side];
      }
    }

    if (this.autoBlinkEnabled && this.elapsed >= this.nextAutoBlink) {
      this.triggerBlink();
      const interval = this.random() < this.doubleBlinkChance
        ? this.randomBetween(...this.doubleBlinkIntervalMs)
        : this.randomBetween(...this.blinkIntervalMs);
      this.nextAutoBlink = this.elapsed + interval / 1000;
    }
    const blinkValue = (side, offsetMs = 0) => {
      if (this.blinkElapsed == null) return this.manualBlink[side];
      if (this.triggerSide !== 'both' && this.triggerSide !== side) return this.manualBlink[side];
      const progress = (this.blinkElapsed * 1000 - offsetMs) / (this.blinkDurationMs * this.transitionCalibration.blinkDurationScale);
      const pulse = progress >= 0 && progress <= 1 ? Math.sin(Math.PI * progress) ** 1.5 : 0;
      return Math.max(this.manualBlink[side], pulse * this.triggerIntensity);
    };
    if (this.blinkElapsed != null) {
      this.blinkElapsed += dt;
      if (this.blinkElapsed * 1000 > this.blinkDurationMs * this.transitionCalibration.blinkDurationScale + this.blinkRightOffsetMs) this.blinkElapsed = null;
    }
    this.currentBlink = {
      left: blinkValue('left'),
      right: blinkValue('right', this.blinkRightOffsetMs),
    };

    const factor = 1 - Math.exp(-dt * this.visemeSpeed);
    for (const name of VISEME_NAMES) {
      const target = this.targetVisemes[name] || 0;
      this.currentVisemes[name] += (target - this.currentVisemes[name]) * factor;
      if (Math.abs(target - this.currentVisemes[name]) < 0.001) this.currentVisemes[name] = target;
    }

    const weights = {};
    const add = (name, value) => {
      if (!value) return;
      weights[name] = (weights[name] || 0) + value;
    };

    for (const name of VISEME_NAMES) {
      const intensity = this.currentVisemes[name] || 0;
      for (const [target, value] of Object.entries(this.visemeMapping[name] || {})) {
        add(target, intensity * (this.calibration.visemeScales[name] || 1) * value);
      }
    }
    for (const [name, value] of Object.entries(this.directVisemeWeights)) add(name, value);
    add('jawOpen', this.jawOpen * this.calibration.jawScale);
    for (const [name, value] of Object.entries(this.supplementalWeights)) add(name, value);
    for (const side of ['left', 'right']) {
      for (const [name, value] of Object.entries(this.blinkMapping[side] || {})) {
        add(name, this.currentBlink[side] * this.calibration.blinkScale * value);
      }
    }
    const gazeDirections = {
      left: Math.max(0, -this.gaze.x),
      right: Math.max(0, this.gaze.x),
      up: Math.max(0, this.gaze.y),
      down: Math.max(0, -this.gaze.y),
    };
    for (const [direction, intensity] of Object.entries(gazeDirections)) {
      for (const [name, value] of Object.entries(this.gazeMapping[direction] || {})) {
        add(name, intensity * this.calibration.gazeScale * value);
      }
    }

    const mouthEmotionGate = 1 - Math.min(0.88, Math.max(0, this.speechAmount) * 0.88);
    for (const [name, value] of Object.entries(emotionWeights || {})) {
      const isMouth = /^(mouth|jaw)/.test(name);
      add(name, Math.min(0.65, Math.max(0, Number(value) || 0)) * (isMouth ? mouthEmotionGate : 1));
    }

    let jawValue = weights.jawOpen || 0;
    let puckerValue = weights.mouthPucker || 0;
    let funnelValue = weights.mouthFunnel || 0;
    if (jawValue > 0.4) {
      puckerValue = 0;
      funnelValue = 0;
    }
    if (puckerValue > 0.3 || funnelValue > 0.3) jawValue = Math.min(jawValue, 0.15);
    if (Object.hasOwn(weights, 'jawOpen')) weights.jawOpen = jawValue;
    if (Object.hasOwn(weights, 'mouthPucker')) weights.mouthPucker = puckerValue;
    if (Object.hasOwn(weights, 'mouthFunnel')) weights.mouthFunnel = funnelValue;

    this.lastMorphWeights = Object.fromEntries(
      Object.entries(weights)
        .map(([name, value]) => [name, Math.max(0, Math.min(1, value))])
        .filter(([, value]) => value > 0),
    );
    return { ...this.lastMorphWeights };
  }

  inspectMorphWeights() {
    return { ...this.lastMorphWeights };
  }

  getVisemeTargets(name) {
    const viseme = normalizeVisemeName(name);
    return viseme ? Object.keys(this.visemeMapping[viseme] || {}) : [];
  }

  getCurrentVisemes() {
    return { ...this.currentVisemes };
  }

  getGaze() {
    return {
      x: this.gaze.x * this.maxGazeX * this.calibration.gazeScale,
      y: this.gaze.y * this.maxGazeY * this.calibration.gazeScale,
    };
  }

  getGazeTargets() {
    return Object.values(this.gazeMapping).flatMap((weights) => Object.keys(weights || {}));
  }

  getBlinkWeights() {
    return { ...this.currentBlink };
  }
}
