import {
  PROFILE_EMOTION_NAMES,
  PROFILE_SCALE_LIMITS,
  PROFILE_VISEME_NAMES,
  createCalibrationProfile,
  parseCalibrationProfileJSON,
  validateCalibrationProfile,
} from '../avatar-core/calibration-profile.js';

const PROFILE_KEY = 'sarra.avatarStudio.calibration.v1';
const emotionLabels = {
  neutre: 'Neutre',
  joie: 'Joie',
  tristesse: 'Tristesse',
  colere: 'Colère',
  surprise: 'Surprise',
  peur: 'Peur',
  degout: 'Dégoût',
  tendresse: 'Tendresse',
  concentration: 'Concentration',
};
const visemeLabels = { AA: 'A', IH: 'I', OU: 'U', EE: 'E', OH: 'O', P: 'P', F: 'F' };
const groups = {
  emotions: PROFILE_EMOTION_NAMES.map((name) => [`parameters.emotionScales.${name}`, emotionLabels[name]]),
  visemes: PROFILE_VISEME_NAMES.map((name) => [`parameters.visemeScales.${name}`, `Visème ${visemeLabels[name]}`])
    .concat([['parameters.jawScale', 'Amplitude de mâchoire']]),
  transitions: [
    ['transitions.emotionScale', 'Lissage des émotions'],
    ['transitions.visemeScale', 'Lissage du lipsync'],
  ],
};

const status = document.getElementById('calibration-status');
const buttons = [...document.querySelectorAll('#calibration-card button')];
const controls = new Map();
let sequence = 0;
let baselineProfile = null;
let channel = null;

function showStatus(message, kind = '') {
  status.textContent = message;
  status.className = `msg ${kind}`;
}

function makeControl(path, label) {
  const wrapper = document.createElement('label');
  wrapper.className = 'calibration-control';
  const title = document.createElement('span');
  const name = document.createElement('span');
  name.textContent = label;
  const output = document.createElement('output');
  output.textContent = '100 %';
  title.append(name, output);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(PROFILE_SCALE_LIMITS.min);
  input.max = String(PROFILE_SCALE_LIMITS.max);
  input.step = String(PROFILE_SCALE_LIMITS.step);
  input.value = '1';
  input.dataset.calibrationSetting = path;
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => {
    output.textContent = `${Math.round(Number(input.value) * 100)} %`;
    showStatus('Ajustements en attente : appliquez-les à l’avatar pour les tester.');
  });
  wrapper.append(title, input);
  controls.set(path, { input, output });
  return wrapper;
}

for (const [group, entries] of Object.entries(groups)) {
  const fieldset = document.querySelector(`[data-calibration-group="${group}"]`);
  for (const [path, label] of entries) fieldset.append(makeControl(path, label));
}

function requestAvatarStudio(action, payload = {}, timeoutMs = 10000) {
  if (!channel) return Promise.reject(new Error('Canal de calibration indisponible.'));
  const requestId = `settings-calibration-${Date.now()}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('L’avatar ne répond pas à la demande de calibration.'));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    channel.postMessage({ type: 'studio-request', requestId, action, payload });
  });
}

const pending = new Map();
function handleStudioResponse(event) {
  const data = event.data;
  if (!data || data.type !== 'studio-response' || typeof data.requestId !== 'string') return;
  const request = pending.get(data.requestId);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(data.requestId);
  if (data.ok) request.resolve(data);
  else request.reject(new Error(data.error || 'Échec de la calibration de l’avatar.'));
}

async function getAvatarState(timeoutMs = 10000) {
  const response = await requestAvatarStudio('state', {}, timeoutMs);
  if (!response.state || !response.state.model) {
    throw new Error('État de calibration de l’avatar invalide.');
  }
  return response.state;
}

function setControls(profile) {
  for (const [path, control] of controls) {
    const [section, group, name] = path.split('.');
    const value = section === 'parameters'
      ? name ? profile.parameters?.[group]?.[name] : profile.parameters?.[group]
      : profile.transitions?.[group];
    const scale = Number.isFinite(value) ? value : 1;
    control.input.value = String(scale);
    control.output.textContent = `${Math.round(scale * 100)} %`;
  }
}

function profileFromState(state) {
  const profile = createCalibrationProfile({
    model: state.model,
    mappings: state.mappings,
    parameters: state.calibration,
    transitions: state.transitions,
  });
  for (const [path, control] of controls) {
    const [section, group, name] = path.split('.');
    const value = Number(control.input.value);
    if (section === 'parameters') {
      if (name) profile.parameters[group] = { ...profile.parameters[group], [name]: value };
      else profile.parameters[group] = value;
    } else {
      profile.transitions[group] = value;
    }
  }
  return profile;
}

function validateProfile(profile, state) {
  const validation = validateCalibrationProfile(profile, state.model);
  if (!validation.compatible) {
    throw new Error(`Profil incompatible : ${validation.reasons.join(', ')}.`);
  }
}

async function applyProfile(profile) {
  const response = await requestAvatarStudio('apply-profile', { profile });
  if (response.state) setControls(profile);
  return response.state;
}

async function withBusy(button, action) {
  buttons.forEach((item) => { item.disabled = true; });
  try {
    await action();
  } catch (error) {
    showStatus(`Erreur : ${error.message || String(error)}`, 'err');
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
    button.disabled = false;
  }
}

document.getElementById('calibration-apply').addEventListener('click', (event) => {
  withBusy(event.currentTarget, async () => {
    const state = await getAvatarState();
    const profile = profileFromState(state);
    validateProfile(profile, state);
    if (!baselineProfile) baselineProfile = createCalibrationProfile({
      model: state.model,
      mappings: state.mappings,
      parameters: state.calibration,
      transitions: state.transitions,
    });
    await applyProfile(profile);
    showStatus('Réglages appliqués temporairement à l’avatar.');
  });
});

document.getElementById('calibration-save').addEventListener('click', (event) => {
  withBusy(event.currentTarget, async () => {
    const state = await getAvatarState();
    const profile = profileFromState(state);
    validateProfile(profile, state);
    await applyProfile(profile);
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch (error) {
      throw new Error(`Réglages appliqués, mais l’enregistrement local a échoué : ${error.message || error}`);
    }
    baselineProfile = null;
    showStatus('Réglages appliqués et enregistrés pour ce modèle VRM.', 'ok');
  });
});

document.getElementById('calibration-restore').addEventListener('click', (event) => {
  withBusy(event.currentTarget, async () => {
    const saved = localStorage.getItem(PROFILE_KEY);
    if (!saved) throw new Error('Aucun profil enregistré pour les visèmes et les émotions.');
    const state = await getAvatarState();
    const parsed = parseCalibrationProfileJSON(saved, state.model);
    if (!parsed.ok) {
      throw new Error(`Profil enregistré incompatible : ${(parsed.validation?.reasons || []).join(', ') || parsed.error}.`);
    }
    if (!baselineProfile) baselineProfile = createCalibrationProfile({
      model: state.model,
      mappings: state.mappings,
      parameters: state.calibration,
      transitions: state.transitions,
    });
    await applyProfile(parsed.profile);
    showStatus('Profil enregistré restauré sur l’avatar.');
  });
});

document.getElementById('calibration-cancel').addEventListener('click', (event) => {
  withBusy(event.currentTarget, async () => {
    if (!baselineProfile) throw new Error('Aucun ajustement temporaire à annuler.');
    const current = await getAvatarState();
    validateProfile(baselineProfile, current);
    await applyProfile(baselineProfile);
    baselineProfile = null;
    showStatus('Ajustement annulé : le profil précédent a été restauré.');
  });
});

async function initializeCalibration(attempt = 0) {
  try {
    const state = await getAvatarState(1500);
    const currentProfile = createCalibrationProfile({
      model: state.model,
      mappings: state.mappings,
      parameters: state.calibration,
      transitions: state.transitions,
    });
    setControls(currentProfile);

    const saved = localStorage.getItem(PROFILE_KEY);
    if (saved) {
      const parsed = parseCalibrationProfileJSON(saved, state.model);
      if (!parsed.ok) {
        showStatus(`Le profil enregistré ne correspond pas à cet avatar : ${(parsed.validation?.reasons || []).join(', ')}.`, 'err');
        return;
      }
      await applyProfile(parsed.profile);
      showStatus('Profil enregistré chargé pour cet avatar.', 'ok');
      return;
    }
    showStatus('Avatar connecté. Ajustez les visèmes, les émotions ou le lipsync.');
  } catch (error) {
    if (attempt < 12) {
      showStatus('En attente du chargement de l’avatar…');
      setTimeout(() => initializeCalibration(attempt + 1), 500);
      return;
    }
    showStatus(`Calibration indisponible : ${error.message || String(error)}`, 'err');
  }
}

try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('sarra-shell');
    channel.addEventListener('message', handleStudioResponse);
    initializeCalibration();
  } else {
    showStatus('Ce navigateur ne prend pas en charge le canal de calibration.', 'err');
  }
} catch (error) {
  showStatus(`Calibration indisponible : ${error.message || String(error)}`, 'err');
}
