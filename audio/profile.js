// Profil audio d’usine de Sarra, partagé en lecture. Les migrations et les
// sauvegardes de profils restent la responsabilité de l’application de bureau.
export const VOWELS = Object.freeze(['A', 'E', 'I', 'O', 'U']);
export const CHANNELS = Object.freeze([...VOWELS, 'P', 'F']);

// Paramètres dynamiques du lipsync qui peuvent être ajustés en direct depuis
// le panneau de configuration (les mappings de morphs restent réservés au
// panneau avancé de l’application).
export const LIPSYNC_DYNAMIC_KEYS = Object.freeze([
  'gain', 'gate', 'atk', 'rel', 'clo', 'hold', 'idle', 'jit', 'cap',
  'jawG', 'jawMax', 'jawLag', 'jawSway', 'jawMorph', 'jawFwd',
  'pucker', 'stretch', 'smile', 'smile0',
  'cps', 'lat', 'coart', 'clos', 'fv', 'rate', 'sens', 'sharp',
  'antic', 'consonantLead', 'textMix',
]);

// Valeurs naturelles utilisées par le panneau de configuration. Les deux
// derniers réglages n’existent pas dans CALIBRATED_DEFAULTS pour préserver
// les profils historiques : l’application les ajoute à son profil d’usine.
export const NATURAL_LIPSYNC_DEFAULTS = Object.freeze({
  coart: 0.55,
  atk: 35,
  rel: 45,
  hold: 25,
  idle: 0.015,
  jit: 0.04,
  clos: 0.18,
  fv: 0.25,
  jawG: 0.6,
  jawLag: 70,
  cps: 14,
  lat: 0,
  rate: 0.9,
  antic: 60,
  consonantLead: 70,
  textMix: 0.6,
});

export const CALIBRATED_DEFAULTS = {
  gain: 0.9,
  gate: 0.03,
  atk: 35,
  rel: 45,
  clo: 28,
  hold: 25,
  idle: 0.015,
  jit: 0.04,
  cap: 1,
  g_A: 0.476,
  m_A: 1,
  b_A: 0,
  g_E: 0.476,
  m_E: 1,
  b_E: 0,
  g_I: 0.476,
  m_I: 1,
  b_I: 0.11,
  g_O: 0.476,
  m_O: 1,
  b_O: 0,
  g_U: 0.476,
  m_U: 1,
  b_U: 0.4,
  g_P: 0.432,
  m_P: 1,
  b_P: 0,
  g_F: 0.432,
  m_F: 1,
  b_F: 0,
  jawG: 0.6,
  jawMax: 7.0,
  jawLag: 70,
  jawSway: 0.06,
  jawMorph: 0.16,
  jawFwd: 0.1,
  jwA: 0.45,
  jwE: 0.24,
  jwI: 0.08,
  jwO: 0.34,
  jwU: 0.15,
  pucker: 1,
  stretch: 1,
  smile: 0.15,
  smile0: 0.04,
  cps: 14,
  lat: 0,
  coart: 0.55,
  clos: 0.18,
  fv: 0.25,
  rate: 0.9,
  sens: 3,
  sharp: 1.2,
  arm: 1.1,
  headm: 0.35,
  browDownLeft: 0,
  browDownRight: 0,
  browInnerUpLeft: 0.01,
  browInnerUpRight: 0,
  browOuterUpLeft: 0,
  browOuterUpRight: 0,
  eyeWideLeft: 0,
  eyeWideRight: 0,
  cheekRaiseLeft: 0,
  cheekRaiseRight: 0,
  mouthFrownLeft: 0,
  mouthFrownRight: 0,
  map: {
    A: {
      aa: 0.345,
      mouthLowerDownLeft: 0.086,
      mouthLowerDownRight: 0.086,
      mouthUpperUpLeft: 0.05,
      mouthUpperUpRight: 0.05,
    },
    E: { E: 0.238, mouthStretchLeft: 0.173, mouthStretchRight: 0.173 },
    I: {
      ih: 0.345,
      mouthStretchLeft: 0.173,
      mouthStretchRight: 0.173,
      mouthSmileLeft: 0.051,
      mouthSmileRight: 0.051,
    },
    O: { oh: 0.324, mouthFunnel: 0.151 },
    U: { ou: 0.345, mouthPucker: 0.194, mouthFunnel: 0.108 },
    P: { PP: 0.432, mouthClose: 0.217, mouthPressLeft: 0.194, mouthPressRight: 0.194 },
    F: { FF: 0.432, mouthRollLower: 0.173 },
  },
  x_AA: 1,
  x_AE: 0,
  x_AI: 0,
  x_AO: 0,
  x_AU: 0,
  x_EA: 0,
  x_EE: 1,
  x_EI: 0,
  x_EO: 0,
  x_EU: 0,
  x_IA: 0,
  x_IE: 0,
  x_II: 1,
  x_IO: 0,
  x_IU: 0,
  x_OA: 0,
  x_OE: 0,
  x_OI: 0,
  x_OO: 1,
  x_OU: 0,
  x_UA: 0,
  x_UE: 0,
  x_UI: 0,
  x_UO: 0,
  x_UU: 1,
};

// L’atelier ne migre ni n’écrit les réglages du bureau. À origine égale,
// lipcfg a priorité sur lipdef, comme dans l’application complète.
export function readWorkshopProfile(storage) {
  const result = structuredClone(CALIBRATED_DEFAULTS);
  for (const key of ['lipdef', 'lipcfg']) {
    try {
      const saved = JSON.parse(storage?.getItem(key) || 'null');
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      for (const name of Object.keys(CALIBRATED_DEFAULTS)) {
        if (name !== 'map' && Number.isFinite(saved[name])) result[name] = saved[name];
      }
      for (const channel of CHANNELS) {
        const weights = saved.map?.[channel];
        if (weights && typeof weights === 'object' && !Array.isArray(weights)) {
          result.map[channel] = Object.fromEntries(
            Object.entries(weights).filter(([, value]) => Number.isFinite(value)),
          );
        }
      }
    } catch {
      /* Pas de stockage / ancien JSON : conserver les valeurs valides. */
    }
  }
  return result;
}
