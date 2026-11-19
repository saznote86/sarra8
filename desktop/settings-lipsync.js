// Panneau « Lipsync naturel » du panneau de configuration.
// Il pilote directement les réglages dynamiques partagés avec l’avatar
// (localStorage `lipcfg` + BroadcastChannel), sans toucher aux profils de
// calibration des morphs gérés par settings-calibration.js.
import {
  CALIBRATED_DEFAULTS,
  LIPSYNC_DYNAMIC_KEYS,
  NATURAL_LIPSYNC_DEFAULTS,
} from '../audio/profile.js';

const CFG_KEY = 'lipcfg';
const DEF_KEY = 'lipdef';
const BUS_NAME = 'sarra-shell';
const TEST_TEXT = 'Ba, bé, bi, bo, bu. Papa, la flûte. Oh ! Aie, oui !';

const CONTROLS = Object.freeze([
  { group: 'dynamic', key: 'atk', label: 'Attaque (ms)', min: 5, max: 150, step: 1, digits: 0 },
  { group: 'dynamic', key: 'rel', label: 'Relâchement (ms)', min: 5, max: 200, step: 1, digits: 0 },
  { group: 'dynamic', key: 'hold', label: 'Maintien (ms)', min: 0, max: 150, step: 1, digits: 0 },
  { group: 'dynamic', key: 'idle', label: 'Repos entrouvert', min: 0, max: 0.2, step: 0.005, digits: 3 },
  { group: 'dynamic', key: 'jit', label: 'Micro-variations', min: 0, max: 0.5, step: 0.01, digits: 2 },
  { group: 'dynamic', key: 'clo', label: 'Fermeture douce (ms)', min: 5, max: 150, step: 1, digits: 0 },

  { group: 'consonants', key: 'clos', label: 'Fermeture P / B / M', min: 0, max: 1, step: 0.01, digits: 2 },
  { group: 'consonants', key: 'fv', label: 'Lèvre F / V', min: 0, max: 1, step: 0.01, digits: 2 },
  { group: 'consonants', key: 'coart', label: 'Co-articulation', min: 0, max: 1, step: 0.01, digits: 2 },
  { group: 'consonants', key: 'antic', label: 'Anticipation voyelle (ms)', min: 0, max: 150, step: 5, digits: 0 },
  { group: 'consonants', key: 'consonantLead', label: 'Anticipation consonne (ms)', min: 0, max: 150, step: 5, digits: 0 },

  { group: 'jaw', key: 'jawG', label: 'Amplitude mâchoire', min: 0, max: 2, step: 0.01, digits: 2 },
  { group: 'jaw', key: 'jawLag', label: 'Inertie mâchoire (ms)', min: 5, max: 300, step: 1, digits: 0 },
  { group: 'jaw', key: 'jawMorph', label: 'Gain jawOpen', min: 0, max: 1.5, step: 0.01, digits: 2 },
  { group: 'jaw', key: 'smile', label: 'Sourire couplé', min: 0, max: 1, step: 0.01, digits: 2 },

  { group: 'sync', key: 'cps', label: 'Débit labial (car./s)', min: 6, max: 30, step: 0.5, digits: 1 },
  { group: 'sync', key: 'rate', label: 'Vitesse de la voix', min: 0.5, max: 1.6, step: 0.05, digits: 2 },
  { group: 'sync', key: 'lat', label: 'Décalage voix / bouche (ms)', min: -300, max: 400, step: 5, digits: 0 },
  { group: 'sync', key: 'textMix', label: 'Poids du texte en direct', min: 0, max: 1, step: 0.01, digits: 2 },
]);

const GROUP_LABELS = {
  dynamic: 'Dynamique',
  consonants: 'Consonnes & anticipation',
  jaw: 'Mâchoire & lèvres',
  sync: 'Synchronisation',
};

const DEFAULTS = (() => {
  const out = {};
  for (const key of LIPSYNC_DYNAMIC_KEYS) {
    if (Number.isFinite(NATURAL_LIPSYNC_DEFAULTS[key])) out[key] = NATURAL_LIPSYNC_DEFAULTS[key];
    else if (Number.isFinite(CALIBRATED_DEFAULTS[key])) out[key] = CALIBRATED_DEFAULTS[key];
  }
  return out;
})();

const bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(BUS_NAME) : null;
const statusEl = document.getElementById('natural-status');
const groupsEl = document.getElementById('natural-lipsync-groups');
const inputs = new Map();
let rawCfg = {};
let values = { ...DEFAULTS };
let persistTimer = 0;

function setStatus(text, kind = '') {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = kind ? `msg ${kind}` : 'msg';
}

function parseStored(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function sanitize(control, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS[control.key];
  return Math.max(control.min, Math.min(control.max, number));
}

function format(control, value) {
  return Number(value).toFixed(control.digits);
}

function readConfig() {
  rawCfg = { ...parseStored(DEF_KEY), ...parseStored(CFG_KEY) };
  values = { ...DEFAULTS };
  for (const control of CONTROLS) {
    if (Number.isFinite(Number(rawCfg[control.key]))) {
      values[control.key] = sanitize(control, rawCfg[control.key]);
    }
  }
}

function dynamicValues() {
  const out = {};
  for (const key of LIPSYNC_DYNAMIC_KEYS) {
    if (Number.isFinite(values[key])) out[key] = values[key];
  }
  return out;
}

function syncInputs() {
  for (const [key, input] of inputs) {
    const control = CONTROLS.find((item) => item.key === key);
    if (!control) continue;
    input.value = String(values[key]);
    const output = input.parentElement && input.parentElement.querySelector('output');
    if (output) output.textContent = format(control, values[key]);
  }
}

function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    try {
      /* On relit la configuration avant d’écrire : les mappings de morphs
         modifiés entre-temps par le panneau avancé sont conservés. */
      rawCfg = parseStored(CFG_KEY);
      localStorage.setItem(CFG_KEY, JSON.stringify({ ...rawCfg, ...dynamicValues() }));
    } catch (_) { /* stockage indisponible : le direct reste actif */ }
  }, 120);
}

function broadcast() {
  if (!bus) return;
  try {
    bus.postMessage({ type: 'lipcfg', cfg: dynamicValues() });
  } catch (_) { /* canal fermé */ }
}

function applyLive() {
  persist();
  broadcast();
}

function buildGroups() {
  if (!groupsEl) return;
  const fieldsets = new Map();
  for (const [id, label] of Object.entries(GROUP_LABELS)) {
    const fieldset = document.createElement('fieldset');
    fieldset.dataset.naturalGroup = id;
    const legend = document.createElement('legend');
    legend.textContent = label;
    fieldset.append(legend);
    groupsEl.append(fieldset);
    fieldsets.set(id, fieldset);
  }

  for (const control of CONTROLS) {
    const label = document.createElement('label');
    label.className = 'calibration-control';
    label.dataset.naturalKey = control.key;
    const head = document.createElement('span');
    const name = document.createElement('span');
    name.textContent = control.label;
    const output = document.createElement('output');
    head.append(name, output);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = String(control.step);
    input.value = String(values[control.key]);
    input.setAttribute('aria-label', control.label);
    output.textContent = format(control, values[control.key]);
    input.addEventListener('input', () => {
      values[control.key] = sanitize(control, input.value);
      output.textContent = format(control, values[control.key]);
      applyLive();
      setStatus('Appliqué en direct sur l’avatar.', 'ok');
    });
    label.append(head, input);
    (fieldsets.get(control.group) || groupsEl).append(label);
    inputs.set(control.key, input);
  }
}

function resetNatural() {
  values = { ...DEFAULTS };
  syncInputs();
  applyLive();
  setStatus('Réglages naturels recommandés réappliqués.', 'ok');
}

function saveDefault() {
  const merged = { ...parseStored(DEF_KEY), ...parseStored(CFG_KEY), ...dynamicValues() };
  try {
    localStorage.setItem(DEF_KEY, JSON.stringify(merged));
    localStorage.setItem(CFG_KEY, JSON.stringify(merged));
    rawCfg = merged;
    setStatus('Enregistré comme défaut : rechargé à chaque démarrage.', 'ok');
  } catch (_) {
    setStatus('Enregistrement impossible (stockage local refusé).', 'err');
  }
}

function testPhrase() {
  if (!bus) {
    setStatus('Avatar indisponible : impossible de lancer le test.', 'err');
    return;
  }
  try {
    bus.postMessage({ type: 'speak', text: TEST_TEXT });
    setStatus('Phrase de test envoyée à l’avatar.', 'ok');
  } catch (_) {
    setStatus('Avatar indisponible : impossible de lancer le test.', 'err');
  }
}

function mergeExternal(source) {
  if (!source || typeof source !== 'object') return false;
  let changed = false;
  for (const control of CONTROLS) {
    if (!Object.prototype.hasOwnProperty.call(source, control.key)) continue;
    const next = sanitize(control, source[control.key]);
    if (values[control.key] !== next) {
      values[control.key] = next;
      changed = true;
    }
  }
  if (changed) syncInputs();
  return changed;
}

function bindEvents() {
  const resetButton = document.getElementById('natural-reset');
  const saveButton = document.getElementById('natural-save');
  const testButton = document.getElementById('natural-test');
  if (resetButton) resetButton.addEventListener('click', resetNatural);
  if (saveButton) saveButton.addEventListener('click', saveDefault);
  if (testButton) testButton.addEventListener('click', testPhrase);

  window.addEventListener('storage', (event) => {
    if (event.key !== CFG_KEY && event.key !== DEF_KEY) return;
    readConfig();
    syncInputs();
    setStatus('Réglages synchronisés depuis l’avatar.', '');
  });

  if (bus) {
    bus.onmessage = (event) => {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'cfg' && data.type !== 'lipcfg') return;
      if (mergeExternal(data.cfg)) setStatus('Réglages synchronisés depuis l’avatar.', '');
    };
  }
}

readConfig();
buildGroups();
bindEvents();
syncInputs();
if (groupsEl) {
  setStatus(
    bus
      ? 'Prêt : les réglages s’appliquent en direct sur l’avatar.'
      : 'Avatar indisponible : les réglages seront appliqués au prochain démarrage.',
    bus ? '' : 'err'
  );
}
