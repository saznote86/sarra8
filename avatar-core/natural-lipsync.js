export const NATURAL_LIPSYNC_DEMO_TEXT =
  'Bonjour, je m’appelle Sarra. Je teste mon lipsync naturel sans réglages prédéfinis.';

export const DEFAULT_NATURAL_LIPSYNC_CONFIG = Object.freeze({
  silenceThreshold: 0.018,
  silenceHangoverSeconds: 0.32,
  attackSeconds: 0.055,
  releaseSeconds: 0.095,
  jawScale: 0.82,
});

export function finiteOr(value, fallback, min = 0, max = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function sanitizeNaturalLipsyncConfig(value = {}) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    silenceThreshold: finiteOr(config.silenceThreshold, DEFAULT_NATURAL_LIPSYNC_CONFIG.silenceThreshold, 0.001, 0.25),
    silenceHangoverSeconds: finiteOr(config.silenceHangoverSeconds, DEFAULT_NATURAL_LIPSYNC_CONFIG.silenceHangoverSeconds, 0, 2),
    attackSeconds: finiteOr(config.attackSeconds, DEFAULT_NATURAL_LIPSYNC_CONFIG.attackSeconds, 0.01, 1),
    releaseSeconds: finiteOr(config.releaseSeconds, DEFAULT_NATURAL_LIPSYNC_CONFIG.releaseSeconds, 0.01, 1.5),
    jawScale: finiteOr(config.jawScale, DEFAULT_NATURAL_LIPSYNC_CONFIG.jawScale, 0, 1),
  };
}

export function frameRateIndependentBlend(current, target, smoothingSeconds, deltaSeconds) {
  const safeCurrent = finiteOr(current, 0);
  const safeTarget = finiteOr(target, safeCurrent);
  const safeDelta = Math.max(0, finiteOr(deltaSeconds, 0, 0, 10));
  const safeSmoothing = Math.max(0.001, finiteOr(smoothingSeconds, 0.08, 0.001, 10));
  if (!safeDelta) return safeCurrent;
  const amount = 1 - Math.exp(-safeDelta / safeSmoothing);
  return finiteOr(safeCurrent + (safeTarget - safeCurrent) * amount, safeCurrent);
}

export class NaturalSpeechGate {
  constructor(config = {}) {
    this.config = sanitizeNaturalLipsyncConfig(config);
    this.speaking = false;
    this.silentFor = 0;
    this.lastEnergy = 0;
  }

  update(rms, deltaSeconds) {
    const energy = finiteOr(rms, 0);
    const delta = Math.max(0, finiteOr(deltaSeconds, 0, 0, 10));
    this.lastEnergy = energy;
    if (energy >= this.config.silenceThreshold) {
      this.speaking = true;
      this.silentFor = 0;
    } else {
      this.silentFor += delta;
      if (this.silentFor >= this.config.silenceHangoverSeconds) this.speaking = false;
    }
    return { speaking: this.speaking, energy };
  }

  reset() {
    this.speaking = false;
    this.silentFor = 0;
    this.lastEnergy = 0;
  }
}

export class NaturalJawEnvelope {
  constructor(config = {}) {
    this.config = sanitizeNaturalLipsyncConfig(config);
    this.value = 0;
    this.gate = new NaturalSpeechGate(config);
  }

  update(rms, deltaSeconds) {
    const gate = this.gate.update(rms, deltaSeconds);
    const raw = gate.speaking
      ? Math.max(0, Math.min(1, (gate.energy - this.config.silenceThreshold) / 0.08))
      : 0;
    const shaped = raw * raw * (3 - 2 * raw) * this.config.jawScale;
    const smoothing = shaped > this.value ? this.config.attackSeconds : this.config.releaseSeconds;
    this.value = frameRateIndependentBlend(this.value, shaped, smoothing, deltaSeconds);
    return {
      jawOpen: this.value,
      speaking: gate.speaking,
      energy: gate.energy,
    };
  }

  reset() {
    this.value = 0;
    this.gate.reset();
  }
}

const DEMO_PHRASES = Object.freeze([
  { start: 0.0, duration: 0.68, viseme: 'A', jaw: 0.58 },
  { start: 0.68, duration: 0.58, viseme: 'O', jaw: 0.38 },
  { start: 1.26, duration: 0.62, viseme: 'I', jaw: 0.30 },
  { start: 1.88, duration: 0.18, viseme: 'P', jaw: 0.04 },
  { start: 2.06, duration: 0.72, viseme: 'A', jaw: 0.56 },
  { start: 2.78, duration: 0.55, viseme: 'E', jaw: 0.42 },
  { start: 3.33, duration: 0.35, viseme: 'I', jaw: 0.28 },
  { start: 3.68, duration: 0.42, viseme: 'U', jaw: 0.26 },
  { start: 4.10, duration: 0.32, viseme: 'A', jaw: 0.50 },
  { start: 4.42, duration: 0.24, viseme: 'P', jaw: 0.06 },
  { start: 4.66, duration: 0.65, viseme: 'O', jaw: 0.44 },
  { start: 5.31, duration: 0.64, viseme: 'E', jaw: 0.40 },
  { start: 5.95, duration: 0.26, viseme: 'I', jaw: 0.24 },
  { start: 6.21, duration: 0.55, viseme: 'P', jaw: 0.05 },
  { start: 6.76, duration: 0.72, viseme: 'A', jaw: 0.55 },
  { start: 7.48, duration: 0.58, viseme: 'U', jaw: 0.30 },
  { start: 8.06, duration: 0.62, viseme: 'E', jaw: 0.38 },
  { start: 8.68, duration: 0.62, viseme: 'O', jaw: 0.42 },
  { start: 9.30, duration: 0.50, viseme: 'I', jaw: 0.26 },
]);

export function sampleNaturalLipsyncDemo(elapsedSeconds) {
  const elapsed = finiteOr(elapsedSeconds, 0, 0, Number.MAX_SAFE_INTEGER);
  const cycle = DEMO_PHRASES[DEMO_PHRASES.length - 1].start +
    DEMO_PHRASES[DEMO_PHRASES.length - 1].duration;
  const loopElapsed = elapsed % (cycle + 1.25);
  if (loopElapsed >= cycle) {
    return { active: false, speaking: false, jawOpen: 0, visemes: { neutral: 1 } };
  }
  const phrase = DEMO_PHRASES.find((entry) => loopElapsed >= entry.start && loopElapsed < entry.start + entry.duration);
  if (!phrase) return { active: true, speaking: false, jawOpen: 0, visemes: { neutral: 1 } };
  const progress = (loopElapsed - phrase.start) / phrase.duration;
  const envelope = Math.sin(Math.PI * Math.min(1, progress));
  const visemes = { neutral: 0 };
  visemes[phrase.viseme] = finiteOr(envelope, 0);
  return {
    active: true,
    speaking: true,
    jawOpen: finiteOr(phrase.jaw * envelope, 0),
    visemes,
  };
}

export class NaturalLipsyncDemo {
  constructor() {
    this.active = false;
    this.startedAt = 0;
    this.savedState = null;
  }

  start(now = Date.now(), state = null) {
    this.savedState = state;
    this.startedAt = now;
    this.active = true;
    return { ok: true, active: true, noSettings: true };
  }

  stop() {
    const restored = this.savedState;
    this.active = false;
    this.startedAt = 0;
    this.savedState = null;
    return { ok: true, active: false, restored };
  }

  sample(now = Date.now()) {
    if (!this.active) return { active: false, speaking: false, jawOpen: 0, visemes: { neutral: 1 } };
    return sampleNaturalLipsyncDemo((now - this.startedAt) / 1000);
  }
}
