export const LIPSYNC_CORPUS = Object.freeze([
  Object.freeze({
    id: 'phrase-voyelles',
    text: 'Sara regarde la lumière et ouvre la bouche.',
    audio: './validation-artifacts/lipsync-autocalibration/vowels.wav',
    duration: 4.184,
    coverage: 'Voyelles et ouverture de bouche',
  }),
  Object.freeze({
    id: 'phrase-labiales',
    text: 'Papa prépare plusieurs beaux bouquets.',
    audio: './validation-artifacts/lipsync-autocalibration/labials.wav',
    duration: 3.595,
    coverage: 'Consonnes labiales P et B',
  }),
  Object.freeze({
    id: 'phrase-alternances',
    text: 'Mimi veut voir où va le bébé.',
    audio: './validation-artifacts/lipsync-autocalibration/rapid.wav',
    duration: 3.24,
    coverage: 'Alternances rapides M, I, F, V et B',
  }),
  Object.freeze({
    id: 'voyelles',
    text: 'Papa a dit mardi, ici, Lou ou Élodie.',
    audio: './validation-artifacts/lipsync-autocalibration/voyelles.wav',
    duration: 3.809,
    coverage: 'Voyelles A, I, OU, É, O',
  }),
  Object.freeze({
    id: 'p-b-m',
    text: 'Papa mange une pomme.',
    audio: './validation-artifacts/lipsync-autocalibration/a.wav',
    duration: 2.179,
    coverage: 'Consonnes P, B, M et voyelles ouvertes',
  }),
  Object.freeze({
    id: 'f-v',
    text: 'Fanny veut voir la fête.',
    audio: './validation-artifacts/lipsync-autocalibration/v.wav',
    duration: 2.479,
    coverage: 'Consonnes F et V',
  }),
  Object.freeze({
    id: 'rapid-alternations',
    text: 'Baba pipi momo. Pipi papa, bababa maman.',
    audio: './validation-artifacts/lipsync-autocalibration/alternate.wav',
    duration: 4.844,
    coverage: 'Alternances rapides et syllabes répétées',
  }),
  Object.freeze({
    id: 'long-with-pauses',
    text: 'Je parle doucement, puis je répète chaque phrase avec le sourire et je fais une pause naturelle.',
    audio: './validation-artifacts/lipsync-autocalibration/long.wav',
    duration: 6.028,
    coverage: 'Phrase longue, pauses et silences',
  }),
]);

const VISEME_NAMES = ['A', 'E', 'I', 'O', 'U', 'P', 'F'];
const CHAR_TO_VISEME = Object.freeze({
  a: 'A', 'à': 'A', 'â': 'A', e: 'E', é: 'E', è: 'E', ê: 'E', i: 'I',
  î: 'I', y: 'I', o: 'O', 'ô': 'O', u: 'U', ù: 'U',
  p: 'P', b: 'P', m: 'P', f: 'F', v: 'F',
});
const normalizeText = (text) => String(text || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function createPhoneticReference(scenario) {
  const text = String(scenario?.text || '');
  const duration = Number(scenario?.duration) || 1;
  const normalized = normalizeText(text);
  const chars = [...normalized].filter((char) => CHAR_TO_VISEME[char]);
  if (!chars.length) return Object.freeze({ timeline: [], method: 'no-phonetic-reference' });

  const timeline = [];
  let cursor = duration * 0.06;
  let phonemeIndex = 0;
  for (const char of normalized) {
    const viseme = CHAR_TO_VISEME[char];
    if (!viseme) continue;
    const span = Math.min(0.16, duration * 0.55 / chars.length);
    timeline.push({
      start: cursor,
      end: cursor + span,
      viseme,
      confidence: 0.35,
      source: 'local-letter-reference',
    });
    cursor += Math.max(0.055, duration * 0.88 / chars.length);
    phonemeIndex += 1;
  }
  void phonemeIndex;
  return Object.freeze({
    method: 'Heuristic French letter-to-viseme reference; not phonetic recognition.',
    timeline,
  });
}

export function samplePhoneticReference(reference, timeSeconds) {
  const time = Math.max(0, Number(timeSeconds) || 0);
  const expected = { A: 0, E: 0, I: 0, O: 0, U: 0, P: 0, F: 0 };
  for (const event of reference?.timeline || []) {
    if (time < event.start || time > event.end) continue;
    const center = (event.start + event.end) / 2;
    const span = Math.max(0.001, (event.end - event.start) / 2);
    expected[event.viseme] = Math.max(expected[event.viseme], Math.cos(Math.PI * Math.min(1, Math.abs(time - center) / span)) * 0.5 + 0.5);
  }
  return Object.freeze({ ...expected });
}

export function measureLipsyncRun({ reference, appliedFrames }) {
  const frames = Array.isArray(appliedFrames) ? appliedFrames : [];
  if (!frames.length) {
    return { ok: false, error: 'no-lipsync-frames', mse: null, frameCount: 0 };
  }
  let squaredError = 0;
  let openingError = 0;
  let silenceFrames = 0;
  let silenceResidual = 0;
  let offsetSamples = 0;
  let bestOffset = 0;
  let bestMse = Number.POSITIVE_INFINITY;
  for (let offsetMs = -180; offsetMs <= 180; offsetMs += 30) {
    let mse = 0;
    let count = 0;
    for (const frame of frames) {
      const expected = samplePhoneticReference(reference, frame.time - offsetMs / 1000);
      for (const viseme of VISEME_NAMES) {
        mse += ((Number(frame.visemes?.[viseme]) || 0) - expected[viseme]) ** 2;
        count += 1;
      }
    }
    mse /= Math.max(1, count);
    if (mse < bestMse) {
      bestMse = mse;
      bestOffset = offsetMs;
    }
  }
  for (const frame of frames) {
    const expected = samplePhoneticReference(reference, frame.time - bestOffset / 1000);
    for (const viseme of VISEME_NAMES) {
      squaredError += ((Number(frame.visemes?.[viseme]) || 0) - expected[viseme]) ** 2;
    }
    const expectedActive = Math.max(0, ...VISEME_NAMES.map((name) => expected[name]));
    if (expectedActive < 0.05) {
      silenceFrames += 1;
      silenceResidual += Number(frame.jawOpen) || 0;
    }
    offsetSamples += 1;
  }
  const mse = squaredError / Math.max(1, offsetSamples * VISEME_NAMES.length);
  openingError = openingError;
  return {
    ok: true,
    mse,
    rmse: Math.sqrt(mse),
    frameCount: frames.length,
    measuredOffsetMs: bestOffset,
    silenceResidual: silenceResidual / Math.max(1, silenceFrames),
    silenceFrames,
  };
}

export function proposeLipsyncCalibration(before, afterRun) {
  const recommendations = [];
  const offset = Number(afterRun?.measuredOffsetMs) || 0;
  const safeOffset = Math.max(-120, Math.min(120, Math.round(offset)));
  if (Math.abs(safeOffset) >= 30) {
    recommendations.push({ parameter: 'latencyMs', value: safeOffset, reason: 'Décalage temporel mesuré hors tolérance.' });
  }
  if ((afterRun?.silenceResidual || 0) > 0.03) {
    recommendations.push({ parameter: 'jawScale', value: 0.9, reason: 'Résidu de mâchoire pendant les silences de référence.' });
  }
  if ((afterRun?.rmse || 0) > 0.18) {
    recommendations.push({ parameter: 'visemeScale', value: 1.1, reason: 'Écart moyen élevé entre visèmes attendus et appliqués.' });
  }
  return Object.freeze({
    ok: true,
    temporary: true,
    recommendations: Object.freeze(recommendations),
    improved: afterRun && before ? afterRun.rmse < before.rmse : false,
  });
}

export function applyTemporaryProposal(core, proposal) {
  if (!core || proposal?.temporary !== true) return { ok: false, error: 'invalid-lipsync-proposal' };
  const active = core.exportCalibration();
  const visemeScales = { ...(active.parameters.visemeScales || {}) };
  const parameters = structuredClone(active.parameters);
  const transitions = { ...(active.transitions || {}) };
  for (const item of proposal.recommendations || []) {
    if (item.parameter === 'jawScale') parameters.jawScale = Math.max(0.8, Math.min(1.2, Number(item.value)));
    if (item.parameter === 'visemeScale') parameters.visemeScales = Object.fromEntries(
      ['AA', 'IH', 'OU', 'EE', 'OH', 'P', 'F'].map((name) => [name, Number(item.value)])
    );
    if (item.parameter === 'visemeTransitionScale') transitions.visemeScale = Math.max(0.8, Math.min(1.2, Number(item.value)));
      if (item.parameter === 'latencyMs') transitions.latencyMs = Math.max(-120, Math.min(120, Number(item.value)));
  }
  parameters.visemeScales ||= visemeScales;
  return core.applyCalibration({ parameters, transitions, mappings: active.mappings });
}
