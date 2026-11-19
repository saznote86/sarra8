'use strict';

/**
 * preload.js — pont IPC des fenêtres Sarra
 * ---------------------------------------------------------------------------
 * Expose deux objets, tous deux issus de `contextBridge` :
 *
 *   window.sarraDesktop   contrat historique attendu par l'app web
 *                         (`Sarra — avatar VRM & lipsync avancé.html`)
 *                         + `window.parent.__sarraBridge` pour la coque.
 *
 *   window.sarra8         API propre au panneau natif de réglages
 *                         (état persistant, onboarding, mémoire, TTS, IA).
 *
 * Aucune API Node n'est exposée : uniquement des canaux IPC nominatifs.
 * ---------------------------------------------------------------------------
 */

const { contextBridge, ipcRenderer } = require('electron');

/* -------------------------------------------------------------------------- */
/* Abonnements typés                                                          */
/* -------------------------------------------------------------------------- */

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (err) {
      console.error(`[preload] ${channel}:`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/* -------------------------------------------------------------------------- */
/* 1. Contrat `window.sarraDesktop`                                           */
/* -------------------------------------------------------------------------- */

/**
 * L'app lit `DESKTOP.voices` de façon synchrone au chargement (proxy
 * `speechSynthesis`). On interroge donc le main en synchrone : il renvoie le
 * cache des voix annoncées par l'hôte Python/Qt (state.json).
 */
let voicesCache = [];
try {
  const sync = ipcRenderer.sendSync('tts:voices-sync');
  if (Array.isArray(sync)) voicesCache = sync;
} catch (err) {
  console.warn('[preload] voices indisponibles :', err && err.message);
}

const ttsListeners = new Set();
const liveListeners = new Set();

const sarraDesktop = {
  /* --- Voix / synthèse (hôte Python/Qt) --- */
  voices: voicesCache,
  getVoices() {
    return ipcRenderer.sendSync('tts:voices-sync') || [];
  },
  speak(payload = {}) {
    ipcRenderer.send('tts:speak', {
      id: payload.id,
      text: String(payload.text || ''),
      voice: payload.voice || '',
      lang: payload.lang || 'fr-FR',
      rate: Number(payload.rate) || 1,
      volume: Number(payload.volume) || 1
    });
  },
  stop() {
    ipcRenderer.send('tts:stop');
  },
  onTtsEvent(callback) {
    if (typeof callback !== 'function') return;
    ttsListeners.add(callback);
  },
  offTtsEvent(callback) {
    if (typeof callback === 'function') ttsListeners.delete(callback);
  },
  // Voix en ligne : non implémentées côté main -> l'app retombe sur la voix Windows.
  ttsAudio(payload) {
    return ipcRenderer.invoke('tts:audio', payload || {});
  },

  /* --- IA --- */
  generateResponse(payload) {
    return ipcRenderer.invoke('ai:generate', payload || {});
  },

  /* --- Gemini Live (conversation directe, gérée par desktop/live.js) --- */
  liveStart(payload) {
    return ipcRenderer.invoke('live:start', payload || {});
  },
  liveStop(payload) {
    ipcRenderer.send('live:stop', payload || {});
  },
  liveAudio(payload) {
    ipcRenderer.send('live:audio', payload || {});
  },
  liveAudioEnd(payload) {
    ipcRenderer.send('live:audio-end', payload || {});
  },
  liveText(payload) {
    ipcRenderer.send('live:text', payload || {});
  },
  liveToolResponse(payload) {
    ipcRenderer.send('live:tool-response', payload || {});
  },
  onLiveEvent(callback) {
    if (typeof callback === 'function') liveListeners.add(callback);
  },
  offLiveEvent(callback) {
    if (typeof callback === 'function') liveListeners.delete(callback);
  },
  liveStatus() {
    return ipcRenderer.invoke('live:status');
  },
  testApiKey(payload) {
    return ipcRenderer.invoke('ai:test-key', payload || {});
  },

  /* --- Modèle VRM : la coque pousse le modèle par défaut --- */
  onVrmLoad(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('vrm:load', (_event, payload) => {
      try {
        callback(payload);
      } catch (err) {
        console.error('[preload] vrm load:', err);
      }
    });
  },
  onVrmLoadResult(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('vrm:load-result', (_event, payload) => {
      try {
        callback(payload);
      } catch (err) {
        console.error('[preload] vrm result:', err);
      }
    });
  },
  vrmLoaded(result) {
    ipcRenderer.send('vrm:result', result || {});
  },
  startupStatus(state) {
    ipcRenderer.send('avatar:startup-status', state);
  },

  /* --- Fenêtre avatar --- */
  dragStart(point) {
    ipcRenderer.send('avatar:drag-start', { x: point?.x ?? 0, y: point?.y ?? 0 });
  },
  dragMove(point) {
    ipcRenderer.send('avatar:drag-move', { x: point?.x ?? 0, y: point?.y ?? 0 });
  },
  dragEnd() {
    ipcRenderer.send('avatar:drag-end');
  },
  resizeAvatar(size) {
    return ipcRenderer.invoke('avatar:resize', size || {});
  },
  repositionAvatar() {
    return ipcRenderer.invoke('avatar:reposition');
  },
  /** Click-through : false = la souris interagit avec l'avatar. */
  setIgnoreMouseEvents(ignore) {
    ipcRenderer.send('set-ignore-mouse-events', Boolean(ignore));
  },
  setInteractiveLock(locked) {
    ipcRenderer.send('avatar:interactive-lock', Boolean(locked));
  },

  /* --- Fenêtre réglages --- */
  toggleSettings(visible) {
    return ipcRenderer.invoke('settings:toggle', typeof visible === 'boolean' ? visible : undefined);
  },
  closeSettings() {
    return ipcRenderer.invoke('settings:close');
  },
  resizeSettings(size) {
    return ipcRenderer.invoke('settings:resize', size || {});
  },
  settingsDragStart(point) {
    ipcRenderer.send('settings:drag-start', { x: point?.x ?? 0, y: point?.y ?? 0 });
  },
  settingsDragMove(point) {
    ipcRenderer.send('settings:drag-move', { x: point?.x ?? 0, y: point?.y ?? 0 });
  },
  settingsDragEnd() {
    ipcRenderer.send('settings:drag-end');
  },

  /* --- Divers --- */
  showMenu() {
    ipcRenderer.send('app:menu');
  },
  openExternal(url) {
    return ipcRenderer.invoke('app:open-external', url);
  },
  quit() {
    return ipcRenderer.invoke('app:quit');
  },
  reload() {
    return ipcRenderer.invoke('app:reload');
  },
  getAppInfo() {
    return ipcRenderer.invoke('app:info');
  },

  /* --- État persistant (utilisé par le panneau natif) --- */
  getState() {
    return ipcRenderer.invoke('state:get');
  },
  saveState(patch) {
    return ipcRenderer.invoke('state:save', patch || {});
  },
  saveDefaults(patch) {
    return ipcRenderer.invoke('state:save-defaults', patch || {});
  },
  onboardingStatus() {
    return ipcRenderer.invoke('onboarding:status');
  },
  completeOnboarding() {
    return ipcRenderer.invoke('onboarding:complete');
  },
  getHistory(limit) {
    return ipcRenderer.invoke('history:get', limit || 200);
  },
  clearHistory() {
    return ipcRenderer.invoke('history:clear');
  },
  getTtsStatus() {
    return ipcRenderer.invoke('tts:status');
  },

  /* --- Événements (retourne une fonction de désabonnement) --- */
  on(channel, callback) {
    const allowed = new Set([
      'app:init',
      'trigger-onboarding',
      'onboarding:completed',
      'state:updated',
      'state:saved',
      'chat:exchange',
      'history:cleared',
      'tts:status',
      'tts:voices',
      'tts:event',
      'live:event',
      'vrm:missing',
      'vrm:status',
      'click-through:changed',
      'click-through:locked'
    ]);
    if (!allowed.has(channel)) {
      console.warn(`[preload] canal non autorisé : ${channel}`);
      return () => {};
    }
    return subscribe(channel, callback);
  }
};

// Diffusion des événements Gemini Live vers les abonnés `onLiveEvent`.
ipcRenderer.on('live:event', (_event, payload) => {
  for (const listener of Array.from(liveListeners)) {
    try {
      listener(payload);
    } catch (err) {
      console.error('[preload] live listener:', err);
    }
  }
});

// Diffusion des événements TTS vers les abonnés `onTtsEvent` de l'app.
ipcRenderer.on('tts:event', (_event, payload) => {
  for (const listener of Array.from(ttsListeners)) {
    try {
      listener(payload);
    } catch (err) {
      console.error('[preload] tts listener:', err);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 2. Coque / panneau natif                                                   */
/* -------------------------------------------------------------------------- */

const sarra8 = {
  /* État */
  getState: () => ipcRenderer.invoke('state:get'),
  saveState: (patch) => ipcRenderer.invoke('state:save', patch || {}),
  saveDefaults: (patch) => ipcRenderer.invoke('state:save-defaults', patch || {}),
  getHistory: (limit) => ipcRenderer.invoke('history:get', limit || 200),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  /* Onboarding */
  onboardingStatus: () => ipcRenderer.invoke('onboarding:status'),
  completeOnboarding: () => ipcRenderer.invoke('onboarding:complete'),

  /* IA */
  generateResponse: (payload) => ipcRenderer.invoke('ai:generate', payload || {}),
  testApiKey: (payload) => ipcRenderer.invoke('ai:test-key', payload || {}),
  liveStatus: () => ipcRenderer.invoke('live:status'),

  /* TTS */
  getTtsStatus: () => ipcRenderer.invoke('tts:status'),
  restartTts: () => ipcRenderer.invoke('tts:restart'),
  speak: (payload) => ipcRenderer.send('tts:speak', payload || {}),
  stopSpeaking: () => ipcRenderer.send('tts:stop'),

  /* Fenêtres */
  toggleSettings: (visible) => ipcRenderer.invoke('settings:toggle', visible),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  dragStart: (point) => ipcRenderer.send('settings:drag-start', point || {}),
  dragMove: (point) => ipcRenderer.send('settings:drag-move', point || {}),
  dragEnd: () => ipcRenderer.send('settings:drag-end'),
  resizeSettings: (size) => ipcRenderer.invoke('settings:resize', size || {}),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', Boolean(ignore)),
  setOpacity: (value) => ipcRenderer.invoke('avatar:set-opacity', value),
  recenter: () => ipcRenderer.invoke('avatar:recenter'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  quit: () => ipcRenderer.invoke('app:quit'),
  reload: () => ipcRenderer.invoke('app:reload'),

  /* Événements */
  on: (channel, callback) => sarraDesktop.on(channel, callback)
};

/* -------------------------------------------------------------------------- */
/* 3. Exposition                                                              */
/* -------------------------------------------------------------------------- */

contextBridge.exposeInMainWorld('sarraDesktop', sarraDesktop);
contextBridge.exposeInMainWorld('sarra8', sarra8);

// La coque et les iframes partagent la même origine (serveur local) :
// l'app peut donc récupérer le pont via `window.parent.__sarraBridge`.
contextBridge.exposeInMainWorld('__sarraBridge', sarraDesktop);
