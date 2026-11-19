import { PROFILE_SCALE_LIMITS } from './calibration-profile.js';

export {
  AVATAR_CORE_VERSION,
  CALIBRATION_PROFILE_VERSION,
  createCalibrationProfile,
  parseCalibrationProfileJSON,
  validateCalibrationProfile,
} from './calibration-profile.js';

export const STUDIO_SCENARIOS = Object.freeze([
  ...[
    ['neutre', 'Neutre'],
    ['joie', 'Joie'],
    ['tristesse', 'Tristesse'],
    ['colere', 'Colère'],
    ['surprise', 'Surprise'],
    ['peur', 'Peur'],
    ['degout', 'Dégoût'],
    ['tendresse', 'Tendresse'],
    ['concentration', 'Concentration'],
  ].map(([emotion, label]) => Object.freeze({
    id: `emotion-${emotion}`,
    label: `Émotion · ${label}`,
    stimulus: Object.freeze({ emotion, intensity: 1 }),
    requiredTargets: Object.freeze([]),
  })),
  ...[
    ['A', 'AA'],
    ['I', 'IH'],
    ['U', 'OU'],
    ['E', 'EE'],
    ['O', 'OH'],
    ['P', 'P'],
    ['F', 'F'],
  ].map(([viseme, label]) => Object.freeze({
    id: `viseme-${viseme}`,
    label: `Visème · ${label}`,
    stimulus: Object.freeze({ viseme, intensity: 1 }),
    requiredTargets: Object.freeze([]),
  })),
  Object.freeze({ id: 'jaw-open', label: 'Mâchoire · JawOpen', stimulus: Object.freeze({ jawOpen: 0.7 }), requiredTargets: Object.freeze(['jawOpen']) }),
  Object.freeze({ id: 'gaze-left', label: 'Regard · Gauche', stimulus: Object.freeze({ gaze: [-1, 0] }), requiredTargets: Object.freeze([]) }),
  Object.freeze({ id: 'gaze-right', label: 'Regard · Droite', stimulus: Object.freeze({ gaze: [1, 0] }), requiredTargets: Object.freeze([]) }),
  Object.freeze({ id: 'gaze-up', label: 'Regard · Haut', stimulus: Object.freeze({ gaze: [0, 1] }), requiredTargets: Object.freeze([]) }),
  Object.freeze({ id: 'gaze-down', label: 'Regard · Bas', stimulus: Object.freeze({ gaze: [0, -1] }), requiredTargets: Object.freeze([]) }),
  Object.freeze({ id: 'blink', label: 'Clignement · Deux yeux', stimulus: Object.freeze({ blink: 1 }), requiredTargets: Object.freeze(['eyeBlinkLeft', 'eyeBlinkRight']) }),
  Object.freeze({ id: 'combined', label: 'Combiné · joie + parole + regard', stimulus: Object.freeze({ emotion: 'joie', intensity: 1, viseme: 'A', speechAmount: 0.8, gaze: [0.35, 0.1], blink: 0.25 }), requiredTargets: Object.freeze([]) }),
]);

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, min, max) => Math.max(min, Math.min(max, Number(value)));
const clone = (value) => structuredClone(value);
const EMOTION_PARAMETER_NAMES = new Set([
  'neutre', 'joie', 'tristesse', 'colere', 'surprise', 'peur', 'degout',
  'tendresse', 'concentration',
]);
export function analyzeFacialState({
  weights = {},
  availableTargets = [],
  requiredTargets = [],
  speechAmount = 0,
  transitionDelta = {},
  maxTransitionRate = 8,
  symmetryPairs = [
    ['mouthSmileLeft', 'mouthSmileRight'],
    ['eyeBlinkLeft', 'eyeBlinkRight'],
    ['eyeWideLeft', 'eyeWideRight'],
    ['eyeSquintLeft', 'eyeSquintRight'],
    ['mouthFrownLeft', 'mouthFrownRight'],
  ],
  symmetryTolerance = 0.35,
} = {}) {
  const targets = new Set(availableTargets);
  const issues = [];
  const missingTargets = requiredTargets.filter((name) => !targets.has(name));
  for (const name of missingTargets) {
    issues.push({ code: 'missing-target', severity: 'warning', target: name, message: `Morph target absent: ${name}` });
  }
  for (const [name, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      issues.push({ code: 'weight-out-of-range', severity: 'error', target: name, value, message: `Poids hors limites: ${name}=${value}` });
    }
  }
  for (const [left, right] of symmetryPairs) {
    if (!targets.has(left) || !targets.has(right)) continue;
    const difference = Math.abs((weights[left] || 0) - (weights[right] || 0));
    if (difference > symmetryTolerance) {
      issues.push({ code: 'asymmetry', severity: 'warning', targets: [left, right], difference, message: `Asymétrie détectée: ${left}/${right}` });
    }
  }

  const jaw = weights.jawOpen || 0;
  const pucker = weights.mouthPucker || 0;
  const funnel = weights.mouthFunnel || 0;
  if ((jaw > 0.4 && (pucker > 0.001 || funnel > 0.001)) || ((pucker > 0.3 || funnel > 0.3) && jaw > 0.15)) {
    issues.push({ code: 'jaw-pucker-conflict', severity: 'warning', message: 'Conflit JawOpen / mouthPucker / mouthFunnel.' });
  }
  const blink = Math.max(weights.eyeBlinkLeft || 0, weights.eyeBlinkRight || 0);
  const eyeEmotion = Math.max(
    weights.eyeWideLeft || 0,
    weights.eyeWideRight || 0,
    weights.eyeSquintLeft || 0,
    weights.eyeSquintRight || 0,
  );
  if (blink > 0.05 && eyeEmotion > 0.05) {
    issues.push({ code: 'blink-emotion-overlap', severity: 'info', message: 'Clignement superposé à une expression des yeux.' });
  }
  const mouthEmotion = Object.entries(weights)
    .filter(([name]) => /^(mouth|jaw)/.test(name) && name !== 'jawOpen')
    .reduce((sum, [, value]) => sum + value, 0);
  if (speechAmount > 0.05 && mouthEmotion > 0.25) {
    issues.push({ code: 'speech-emotion-overlap', severity: 'warning', message: 'Émotion de bouche élevée pendant la parole.' });
  }
  for (const [name, rate] of Object.entries(transitionDelta)) {
    if (Math.abs(rate) > maxTransitionRate) {
      issues.push({ code: 'abrupt-transition', severity: 'warning', target: name, rate, message: `Transition abrupte: ${name}` });
    }
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    score: Math.max(0, Math.round(100 - errors * 25 - warnings * 8)),
    issues,
    missingTargets,
    weightCount: Object.keys(weights).length,
    passed: errors === 0 && missingTargets.length === 0,
  };
}

export function recordTransitionPeaks(previousWeights, currentWeights, deltaSeconds, peaks = {}) {
  const duration = Math.max(Number(deltaSeconds) || 0, 0.001);
  const next = { ...peaks };
  const targets = new Set([...Object.keys(previousWeights), ...Object.keys(currentWeights)]);
  for (const target of targets) {
    const previous = Number.isFinite(previousWeights[target]) ? previousWeights[target] : 0;
    const current = Number.isFinite(currentWeights[target]) ? currentWeights[target] : 0;
    const rate = (current - previous) / duration;
    if (Math.abs(rate) > Math.abs(next[target] || 0)) next[target] = rate;
  }
  return next;
}

export function interpolateMorphWeights(currentWeights, targetWeights, deltaSeconds, durationMs = 80) {
  const delta = Math.max(0, Number(deltaSeconds) || 0);
  const duration = Math.max(80, Number.isFinite(durationMs) ? durationMs : 80) / 1000;
  const factor = 1 - Math.exp(-delta / duration);
  const next = {};
  const targets = new Set([...Object.keys(currentWeights), ...Object.keys(targetWeights)]);
  for (const target of targets) {
    const current = Number.isFinite(currentWeights[target]) ? currentWeights[target] : 0;
    const desired = Number.isFinite(targetWeights[target]) ? targetWeights[target] : 0;
    let value = current + (desired - current) * factor;
    if (Math.abs(desired - value) < 0.001) value = desired;
    if (value > 0.001) next[target] = value;
  }
  return next;
}

export function comparePixelCaptures(before, after) {
  if (!before || !after || before.width !== after.width || before.height !== after.height ||
      !before.data || !after.data || before.data.length !== after.data.length) {
    return { ok: false, error: 'incompatible-captures' };
  }
  if (before.data.length === 0) return { ok: false, error: 'empty-captures' };
  let total = 0;
  let changed = 0;
  for (let index = 0; index < before.data.length; index += 1) {
    const difference = Math.abs(before.data[index] - after.data[index]);
    total += difference;
    if (difference > 8) changed += 1;
  }
  return {
    ok: true,
    meanAbsoluteDifference: total / before.data.length,
    changedPixelChannelRatio: changed / before.data.length,
  };
}

export function captureCanvas(canvas, metadata = {}) {
  if (!canvas || typeof canvas.toDataURL !== 'function') {
    return Promise.reject(new Error('capture-canvas-unavailable'));
  }
  try {
    return Promise.resolve({
      image: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      capturedAt: new Date().toISOString(),
      metadata: clone(metadata),
    });
  } catch (error) {
    return Promise.reject(new Error(`capture-failed: ${error.message}`));
  }
}

export function applyBoundedProposal(profile, proposal) {
  if (!isRecord(profile) || !isRecord(profile.parameters) || !isRecord(proposal) ||
      typeof proposal.parameter !== 'string') {
    return { ok: false, error: 'unsupported-calibration-parameter' };
  }
  if (!Number.isFinite(proposal.value)) return { ok: false, error: 'invalid-calibration-value' };
  const [group, name] = proposal.parameter.split('.');
  const scalarParameters = new Set(['jawScale', 'gazeScale', 'blinkScale']);
  const emotionNames = new Set(['neutre', 'joie', 'tristesse', 'colere', 'surprise', 'peur', 'degout', 'tendresse', 'concentration']);
  const visemeNames = new Set(['AA', 'IH', 'OU', 'EE', 'OH', 'P', 'F']);
  const updated = clone(profile);
  if (scalarParameters.has(proposal.parameter)) {
    updated.parameters[proposal.parameter] = bounded(proposal.value, PROFILE_SCALE_LIMITS.min, PROFILE_SCALE_LIMITS.max);
  } else if (group === 'emotionScales' && emotionNames.has(name)) {
    updated.parameters.emotionScales = isRecord(updated.parameters.emotionScales) ? updated.parameters.emotionScales : {};
    updated.parameters.emotionScales[name] = bounded(proposal.value, PROFILE_SCALE_LIMITS.min, PROFILE_SCALE_LIMITS.max);
  } else if (group === 'visemeScales' && visemeNames.has(name)) {
    updated.parameters.visemeScales = isRecord(updated.parameters.visemeScales) ? updated.parameters.visemeScales : {};
    updated.parameters.visemeScales[name] = bounded(proposal.value, PROFILE_SCALE_LIMITS.min, PROFILE_SCALE_LIMITS.max);
  } else if (group === 'transitions' && ['emotionScale', 'visemeScale', 'gazeSmoothingScale', 'blinkDurationScale'].includes(name)) {
    updated.transitions = isRecord(updated.transitions) ? updated.transitions : {};
    updated.transitions[name] = bounded(proposal.value, PROFILE_SCALE_LIMITS.min, PROFILE_SCALE_LIMITS.max);
  } else {
    return { ok: false, error: 'unsupported-calibration-parameter' };
  }
  return { ok: true, profile: updated };
}

export function proposeFacialCalibration(profile, analysis, scenario = null) {
  if (!isRecord(profile) || !isRecord(profile.parameters) || !Array.isArray(analysis?.issues)) {
    return [];
  }
  const proposals = new Map();
  const currentValue = (parameter) => {
    const [group, name] = parameter.split('.');
    return group === 'transitions'
      ? Number(profile.transitions?.[name] ?? 1)
      : group === 'emotionScales'
        ? Number(profile.parameters.emotionScales?.[name] ?? 1)
        : Number(profile.parameters[name] ?? 1);
  };
  const add = (parameter, factor, reason) => {
    if (proposals.has(parameter)) return;
    const current = currentValue(parameter);
    if (!Number.isFinite(current)) return;
    const value = bounded(current * factor, PROFILE_SCALE_LIMITS.min, PROFILE_SCALE_LIMITS.max);
    if (value !== current) proposals.set(parameter, { parameter, value, reason });
  };
  const emotion = scenario?.stimulus?.emotion;
  const hasViseme = Boolean(scenario?.stimulus?.viseme);

  for (const issue of analysis.issues) {
    if (issue.code === 'jaw-pucker-conflict') {
      add('jawScale', 0.95, 'Réduire le conflit entre l’ouverture de mâchoire et l’arrondi des lèvres.');
    } else if (issue.code === 'speech-emotion-overlap' && emotion) {
      add(`emotionScales.${emotion}`, 0.8, 'Atténuer l’expression de bouche pendant la parole.');
    } else if (issue.code === 'blink-emotion-overlap') {
      add('blinkScale', 0.95, 'Réduire le chevauchement entre clignement et expression des yeux.');
    } else if (issue.code === 'abrupt-transition') {
      if (typeof issue.target !== 'string') continue;
      if (/^eyeBlink/.test(issue.target)) {
        add('transitions.blinkDurationScale', 1.05, 'Allonger légèrement la transition du clignement.');
      } else if (/^eyeLook/.test(issue.target)) {
        add('transitions.gazeSmoothingScale', 1.05, 'Adoucir la transition du regard.');
      } else if (issue.target === 'jawOpen') {
        add('jawScale', 0.95, 'Réduire la variation brusque de la mâchoire.');
      } else if (/^(brow|cheek|eyeWide|eyeSquint|noseSneer|mouthSmile|mouthFrown|mouthDimple)/.test(issue.target)) {
        add('transitions.emotionScale', 1.05, 'Adoucir la transition de l’expression faciale.');
      } else if (hasViseme) {
        add('transitions.visemeScale', 1.05, 'Adoucir la transition du visème.');
      } else if (emotion) {
        add('transitions.emotionScale', 1.05, 'Adoucir la transition de l’expression faciale.');
      }
    }
  }

  return [...proposals.values()];
}

export class CalibrationRunner {
  constructor({ runScenario, analyze = analyzeFacialState, restore } = {}) {
    if (typeof runScenario !== 'function') throw new TypeError('runScenario must be a function');
    this.runScenario = runScenario;
    this.analyze = analyze;
    this.restore = typeof restore === 'function' ? restore : async () => {};
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  async run(scenarios = STUDIO_SCENARIOS) {
    this.cancelled = false;
    const results = [];
    for (const scenario of scenarios) {
      if (this.cancelled) break;
      const observed = await this.runScenario(scenario);
      results.push({
        scenarioId: scenario.id,
        label: scenario.label,
        observed,
        analysis: this.analyze({
          ...observed,
          requiredTargets: scenario.requiredTargets,
        }),
      });
    }
    return { results, cancelled: this.cancelled };
  }

  async evaluateProposals(profile, proposals, evaluate) {
    if (typeof evaluate !== 'function') throw new TypeError('evaluate must be a function');
    const candidates = [];
    const baseline = await evaluate(profile);
    candidates.push({ profile: clone(profile), result: baseline, baseline: true });
    try {
      for (const proposal of proposals) {
        const applied = applyBoundedProposal(profile, proposal);
        if (!applied.ok) continue;
        const result = await evaluate(applied.profile);
        candidates.push({ profile: applied.profile, result, baseline: false, proposal });
      }
    } finally {
      await this.restore(profile);
    }
    candidates.sort((a, b) => b.result.score - a.result.score);
    return {
      candidates,
      best: candidates[0],
      requiresApproval: true,
      saved: false,
    };
  }
}

export async function waitForCoreConvergence(core, {
  stableFrames = 2,
  timeoutMs = 3000,
  intervalMs = 16,
} = {}) {
  if (!core || typeof core.getSnapshot !== 'function') {
    return { ok: false, error: 'core-snapshot-unavailable' };
  }
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const snapshot = core.getSnapshot();
    if (snapshot.convergence.captureAllowed) return { ok: true, snapshot };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, error: 'capture-convergence-timeout', snapshot: core.getSnapshot() };
}

export async function fingerprintArrayBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || !globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error('model-fingerprint-unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
