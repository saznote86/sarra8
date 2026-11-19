'use strict';

/**
 * Sarra8 — processus principal Electron
 * ===========================================================================
 * Cette version n'ajoute rien à l'app web : elle l'héberge.
 *
 *   serveur statique local  ->  http://127.0.0.1:<port>/Sarra — avatar ….html
 *   fenêtre avatar          ->  desktop/shell.html?mode=avatar  (iframe ?shell=avatar)
 *   fenêtre réglages        ->  desktop/shell.html?mode=settings (panneau unique)
 *   desktop/state.json      ->  identité, clé Gemini, coreDirectives, chatHistory
 *   hôte vocal Python/Qt    ->  127.0.0.1:8649 (JSON par ligne, voir lib/tts-bridge.js)
 *
 * Fonctionnalités demandées :
 *   1. Fenêtre avatar transparente, sans cadre, alwaysOnTop, click-through
 *      dynamique (`setIgnoreMouseEvents` + IPC `set-ignore-mouse-events`).
 *   2. Bouton micro (dans l'app, en bas au centre), avatar déplaçable /
 *      redimensionnable, survol -> interaction.
 *   3. Réglages cachés au démarrage, toggle global Ctrl+Shift+K.
 *   4. Persistance state.json + section « Core Directives » + mémoire injectée
 *      dans les appels Gemini (10 derniers échanges).
 *   5. Gemini par défaut, onboarding forcé si `onboardingCompleted === false`.
 * ===========================================================================
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  session,
  Menu,
  shell,
  dialog
} = require('electron');

const fs = require('fs');
const http = require('http');
const path = require('path');

const { StateStore, hasRequiredOnboardingFields, clampNumber } = require('./lib/state-store');
const gemini = require('./lib/gemini');
const { TtsHostBridge, DEFAULT_HOST, DEFAULT_PORT } = require('./lib/tts-bridge');
const { LiveManager } = require('./live');
const { composeLiveInstruction } = require('./lib/live-instruction');

/* -------------------------------------------------------------------------- */
/* Constantes                                                                 */
/* -------------------------------------------------------------------------- */

const APP_FILE = 'Sarra — avatar VRM & lipsync avancé.html';
const DEFAULT_VRM_CANDIDATES = ['sarra7.vrm', 'sarra7c.vrm'];
const ROOT = path.join(__dirname, '..');           // racine du dépôt (app web + avatar-core)
const DESKTOP = __dirname;

const AVATAR_MIN_W = 160;
const AVATAR_MAX_W = 900;
const AVATAR_ASPECT_BODY = 1.8;   // h  = w * 1.8 (cadrage avec buste)
const AVATAR_ASPECT_HEAD = 1.1;   // h  = w * 1.1 (cadrage tête, défaut de l'app)
const SETTINGS_MIN = { width: 760, height: 520 };

const SHORTCUT_TOGGLE_SETTINGS = 'CommandOrControl+Shift+K';
const SHORTCUT_INTERACTIVE_LOCK = 'CommandOrControl+Shift+L';
const SHORTCUT_QUIT = 'CommandOrControl+Shift+Q';

const isDev = !app.isPackaged;

/* -------------------------------------------------------------------------- */
/* État du processus                                                          */
/* -------------------------------------------------------------------------- */

let server = null;
let baseUrl = null;

let splashWindow = null;
let avatarWindow = null;
let avatarReadyToShow = false;
let avatarStartupState = 'loading';
let settingsWindow = null;

let tts = null;
let ttsStatus = { status: 'idle', available: false, voices: [], lastError: null };

/** Sessions Gemini Live : id -> { owner, input, output[] } (transcriptions). */
let liveManager = null;
const liveSessions = new Map();

let isQuitting = false;
let hitTestTimer = null;

const clickThrough = {
  ignoring: null,        // null = pas encore appliqué
  interactiveLocked: false,
  graceUntil: 0
};

let dragContext = null;

const store = new StateStore({
  dir: DESKTOP,
  fallbackDir: (() => {
    try {
      return app.getPath('userData');
    } catch (_) {
      return null;
    }
  })(),
  logger: console
});

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

const alive = (win) => Boolean(win) && !win.isDestroyed();

function sendTo(win, channel, payload) {
  if (!alive(win)) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return false;
  if (wc.isLoadingMainFrame()) wc.once('did-finish-load', () => !wc.isDestroyed() && wc.send(channel, payload));
  else wc.send(channel, payload);
  return true;
}

function broadcast(channel, payload) {
  sendTo(avatarWindow, channel, payload);
  sendTo(settingsWindow, channel, payload);
}

const logError = (scope, err) =>
  console.error(`[${scope}] ${err && err.message ? err.message : err}${isDev && err && err.stack ? `\n${err.stack}` : ''}`);

/* -------------------------------------------------------------------------- */
/* Serveur statique local (nécessaire aux modules ES et à fetch(sarra7.vrm))   */
/* -------------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.vrm': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2'
};

// Jamais servis : secrets et journaux restent dans le processus principal.
const DENY = new Set(['/desktop/state.json', '/desktop/tts-host.log', '/desktop/start.log', '/start.log', '/boot.log']);

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        const pathname = decodeURIComponent(requestUrl.pathname);

        if (DENY.has(pathname) || pathname.startsWith('/.git')) {
          res.writeHead(403).end('Forbidden');
          return;
        }

        const filePath = path.join(ROOT, path.normalize(pathname));
        if (!filePath.startsWith(ROOT)) {
          res.writeHead(403).end('Forbidden');
          return;
        }

        fs.stat(filePath, (err, stat) => {
          if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
            return;
          }
          const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': stat.size,
            'Cache-Control': 'no-store'
          });
          if (req.method === 'HEAD') return res.end();
          fs.createReadStream(filePath).pipe(res);
        });
      } catch (err) {
        res.writeHead(500).end('Internal error');
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`[server] ${baseUrl}`);
      resolve(baseUrl);
    });
  });
}

const appUrl = () => `${baseUrl}/${encodeURI(APP_FILE)}`;
const shellUrl = (mode) =>
  `${baseUrl}/desktop/shell.html?mode=${mode}&app=${encodeURIComponent(appUrl())}`;

function closeSplashWindow() {
  const win = splashWindow;
  splashWindow = null;
  if (alive(win)) win.close();
}

function createSplashWindow() {
  if (alive(splashWindow)) return splashWindow;

  const win = new BrowserWindow({
    width: 360,
    height: 160,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#10131a',
    title: 'Sarra8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  splashWindow = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.once('ready-to-show', () => {
    if (!alive(win)) return;
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  });
  win.on('closed', () => {
    if (splashWindow === win) splashWindow = null;
  });
  win.loadFile(path.join(DESKTOP, 'splash.html')).catch((err) => {
    logError('splash', err);
    closeSplashWindow();
  });
  return win;
}

function showAvatarAfterStartup() {
  if (!avatarReadyToShow || avatarStartupState === 'loading' || !alive(avatarWindow)) return;
  avatarWindow.setOpacity(clampNumber(store.state.avatar.opacity, 0.2, 1, 1));
  avatarWindow.showInactive();
  avatarWindow.setAlwaysOnTop(true, 'screen-saver');
  closeSplashWindow();
}

/* -------------------------------------------------------------------------- */
/* 1. Fenêtre avatar                                                          */
/* -------------------------------------------------------------------------- */

function avatarInitialBounds() {
  const a = store.state.avatar || {};
  const width = Math.round(clampNumber(a.width, AVATAR_MIN_W, AVATAR_MAX_W, 320));
  const height = Math.round(clampNumber(a.height, AVATAR_MIN_W, 1200, Math.round(width * AVATAR_ASPECT_HEAD)));
  const { workArea } = screen.getPrimaryDisplay();

  let x = Number.isFinite(Number(a.x)) ? Math.round(Number(a.x)) : workArea.x + workArea.width - width - 40;
  let y = Number.isFinite(Number(a.y)) ? Math.round(Number(a.y)) : workArea.y + workArea.height - height - 40;

  const display = screen.getDisplayNearestPoint({ x, y }) || screen.getPrimaryDisplay();
  const wa = display.workArea;
  if (x + width < wa.x + 80) x = wa.x + 8;
  if (x > wa.x + wa.width - 80) x = wa.x + wa.width - width - 8;
  if (y + height < wa.y + 80) y = wa.y + 8;
  if (y > wa.y + wa.height - 80) y = wa.y + wa.height - height - 8;

  return { x, y, width, height };
}

function createAvatarWindow() {
  avatarReadyToShow = false;
  avatarStartupState = 'loading';
  const bounds = avatarInitialBounds();

  avatarWindow = new BrowserWindow({
    ...bounds,
    // --- exigences de la tâche 1 ---
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    // --- confort overlay ---
    hasShadow: false,
    resizable: false,      // redimensionnement manuel (molette / bords)
    movable: false,        // déplacement manuel (drag IPC de l'app)
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'Sarra',
    webPreferences: {
      preload: path.join(DESKTOP, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,              // l'app tourne déjà avec --no-sandbox (voir README)
      backgroundThrottling: false,
      webgl: true,
      spellcheck: false
    }
  });

  avatarWindow.setAlwaysOnTop(true, 'screen-saver');
  avatarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Click-through par défaut ; `forward` permet de garder les mousemove sous Windows.
  avatarWindow.setIgnoreMouseEvents(true, { forward: true });
  clickThrough.ignoring = true;

  avatarWindow.loadURL(shellUrl('avatar'));

  avatarWindow.once('ready-to-show', () => {
    if (!alive(avatarWindow)) return;
    avatarReadyToShow = true;
    showAvatarAfterStartup();
  });

  // Le README impose de réappliquer le premier plan à l'affichage / au focus.
  avatarWindow.on('show', () => alive(avatarWindow) && avatarWindow.setAlwaysOnTop(true, 'screen-saver'));
  avatarWindow.on('focus', () => alive(avatarWindow) && avatarWindow.setAlwaysOnTop(true, 'screen-saver'));

  avatarWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  stopLiveForWindow(avatarWindow);

  avatarWindow.on('closed', () => {
    avatarWindow = null;
    if (!isQuitting) app.quit();
  });

  return avatarWindow;
}

/* -------------------------------------------------------------------------- */
/* Click-through                                                              */
/* -------------------------------------------------------------------------- */

function applyIgnoreMouseEvents(ignore, opts = {}) {
  if (!alive(avatarWindow)) return clickThrough.ignoring;
  const value = Boolean(ignore);
  if (!opts.force && clickThrough.interactiveLocked && value) return clickThrough.ignoring;
  if (clickThrough.ignoring === value) return clickThrough.ignoring;

  avatarWindow.setIgnoreMouseEvents(value, { forward: true });
  clickThrough.ignoring = value;
  sendTo(avatarWindow, 'click-through:changed', value);
  return clickThrough.ignoring;
}

/**
 * Surveillance du curseur.
 *
 * L'app vit dans une iframe : ses pointer events ne remontent pas au document
 * du shell, et `forward:true` n'existe que sous Windows. Le test matériel
 * (position du curseur vs. bounds) est donc la seule méthode fiable partout ;
 * le shell peut de toute façon forcer l'état via `set-ignore-mouse-events`.
 */
function startHitTestWatcher() {
  if (hitTestTimer) clearInterval(hitTestTimer);
  hitTestTimer = setInterval(() => {
    if (!alive(avatarWindow) || dragContext || clickThrough.interactiveLocked) return;
    if (clickThrough.graceUntil > Date.now()) return;
    try {
      const p = screen.getCursorScreenPoint();
      const b = avatarWindow.getBounds();
      const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
      applyIgnoreMouseEvents(!inside);
    } catch (_) {
      /* écran en reconfiguration */
    }
  }, 70);
  if (hitTestTimer.unref) hitTestTimer.unref();
}

function stopHitTestWatcher() {
  if (hitTestTimer) clearInterval(hitTestTimer);
  hitTestTimer = null;
}

function recenterAvatar() {
  if (!alive(avatarWindow)) return null;
  const { workArea } = screen.getPrimaryDisplay();
  const [width, height] = avatarWindow.getSize();
  const x = workArea.x + workArea.width - width - 40;
  const y = workArea.y + workArea.height - height - 40;
  avatarWindow.setPosition(x, y);
  store.patch({ avatar: { x, y } });
  return { x, y };
}

/* -------------------------------------------------------------------------- */
/* 3. Fenêtre réglages                                                        */
/* -------------------------------------------------------------------------- */

function createSettingsWindow() {
  if (alive(settingsWindow)) return settingsWindow;

  const s = store.state.settings || {};
  settingsWindow = new BrowserWindow({
    width: Math.max(SETTINGS_MIN.width, Number(s.width) || 980),
    height: Math.max(SETTINGS_MIN.height, Number(s.height) || 760),
    x: Number.isFinite(Number(s.x)) ? Number(s.x) : undefined,
    y: Number.isFinite(Number(s.y)) ? Number(s.y) : undefined,
    minWidth: SETTINGS_MIN.width,
    minHeight: SETTINGS_MIN.height,
    show: false,                  // <-- cachée au démarrage (tâche 3)
    frame: false,
    transparent: false,
    backgroundColor: '#10131a',
    alwaysOnTop: true,            // l'overlay reste au-dessus des fenêtres ordinaires
    skipTaskbar: false,
    title: 'Sarra — Réglages',
    webPreferences: {
      preload: path.join(DESKTOP, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  settingsWindow.setAlwaysOnTop(true, 'floating');
  settingsWindow.loadURL(shellUrl('settings'));

  // Fermer = cacher : Sarra continue de vivre dans la fenêtre avatar.
  settingsWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    settingsWindow.hide();
  });

  stopLiveForWindow(settingsWindow);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  const persist = () => {
    if (!alive(settingsWindow)) return;
    const [x, y] = settingsWindow.getPosition();
    const [width, height] = settingsWindow.getSize();
    store.patch({ settings: { x, y, width, height } });
  };
  settingsWindow.on('moved', persist);
  settingsWindow.on('resized', persist);

  return settingsWindow;
}

function toggleSettingsWindow(force) {
  const win = createSettingsWindow();
  const show = typeof force === 'boolean' ? force : !win.isVisible();
  if (show) {
    win.show();
    win.focus();
    win.setAlwaysOnTop(true, 'floating');
  } else {
    win.hide();
  }
  return show;
}

/* -------------------------------------------------------------------------- */
/* Modèle VRM par défaut (sarra7.vrm à la racine du dépôt)                    */
/* -------------------------------------------------------------------------- */

/**
 * L'app ne charge aucun modèle d'elle-même : elle attend un fichier choisi par
 * l'utilisateur (`<input type=file>`) ou poussé par `DESKTOP.onVrmLoad`.
 * La coque assure donc le chargement du modèle par défaut, sans modifier le
 * moteur VRM ni le lipsync.
 */
function findDefaultVrm() {
  for (const candidate of DEFAULT_VRM_CANDIDATES) {
    const file = path.join(ROOT, candidate);
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 1024) return file;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

let defaultVrmReported = false;

/**
 * L'application se charge elle-même de `sarra7.vrm` (voir le bloc
 * « modèle par défaut » dans l'app web) et rend compte via `DESKTOP.vrmLoaded`.
 * La coque se contente donc de signaler l'absence du fichier pour que l'écran
 * de démarrage propose l'import d'un VRM au lieu d'attendre indéfiniment.
 */
function checkDefaultVrm() {
  if (defaultVrmReported) return;
  const file = findDefaultVrm();
  if (file) return; // l'app le charge et rapportera le résultat

  sendTo(avatarWindow, 'vrm:missing', {
    message:
      "Aucun modèle par défaut : placez sarra7.vrm à la racine du dépôt, ou importez un fichier VRM depuis les Réglages."
  });
  defaultVrmReported = true;
}

/* -------------------------------------------------------------------------- */
/* Gemini Live (conversation directe, desktop/live.js)                        */
/* -------------------------------------------------------------------------- */

function initLive() {
  liveManager = new LiveManager({ log: (message) => console.log(`[live] ${message}`) });
}

/** Arrête les sessions Live d'une fenêtre (fermeture / rechargement). */
function stopLiveForWindow(win) {
  if (!alive(win)) return;
  const ownerId = win.webContents.id;
  win.webContents.once('destroyed', () => {
    if (!liveManager) return;
    try {
      liveManager.stopOwner(ownerId);
    } catch (_) {
      /* ignore */
    }
    for (const [sessionId, session] of liveSessions) {
      if (session.owner === ownerId) liveSessions.delete(sessionId);
    }
  });
}

/**
 * Enregistre un tour complet dans la mémoire persistante (state.json), pour que
 * la conversation directe reste dans l'historique des 10 derniers échanges.
 */
function commitLiveTurn(sessionId, session = null, force = false) {
  const target = session || liveSessions.get(sessionId);
  if (!target) return;
  const input = String(target.input || '').trim();
  const output = String((target.output || []).join(' ')).trim();
  if (!input && !output) return;
  if (!force && (!input || !output)) return;

  store.addExchange(input, output);
  target.input = '';
  target.output = [];
  broadcast('chat:exchange', { prompt: input, reply: output, ts: Date.now(), source: 'live' });
}

function liveEmitTo(win, event) {
  sendTo(win, 'live:event', event);
}

/* -------------------------------------------------------------------------- */
/* Hôte vocal Python/Qt                                                       */
/* -------------------------------------------------------------------------- */

function startTts() {
  stopTts();
  const ttsCfg = store.state.tts || {};

  tts = new TtsHostBridge({
    host: ttsCfg.host || DEFAULT_HOST,
    port: Number(ttsCfg.port) || DEFAULT_PORT,
    pythonPath: ttsCfg.pythonPath,
    scriptPath: ttsCfg.hostScript ? path.resolve(ROOT, ttsCfg.hostScript) : path.join(DESKTOP, 'tts', 'tts_host.py'),
    logPath: path.join(app.getPath('userData'), 'tts-host.log'),
    voices: Array.isArray(ttsCfg.voices) ? ttsCfg.voices : [],
    spawnEnabled: ttsCfg.spawn !== false,
    logger: console
  });

  tts.on('status', (status) => {
    ttsStatus = status;
    if (status.voices && status.voices.length) store.patch({ tts: { voices: status.voices } });
    broadcast('tts:status', status);
  });
  tts.on('voices', (voices) => {
    store.patch({ tts: { voices } });
    broadcast('tts:voices', voices);
  });
  tts.on('tts-event', (event) => broadcast('tts:event', event));
  tts.on('log', (line) => console.log(`[tts] ${line}`));

  tts.start();
}

function stopTts() {
  if (!tts) return;
  try {
    tts.removeAllListeners();
    tts.dispose();
  } catch (_) {
    /* ignore */
  }
  tts = null;
}

/* -------------------------------------------------------------------------- */
/* 4. Persistance / 5. Onboarding                                             */
/* -------------------------------------------------------------------------- */

function missingOnboardingFields(state) {
  const missing = [];
  if (!String(state.avatarName || '').trim()) missing.push('avatarName');
  if (!String(state.userName || '').trim()) missing.push('userName');
  if (!String(state.geminiApiKey || '').trim()) missing.push('geminiApiKey');
  return missing;
}

function onboardingPayload() {
  return {
    missing: missingOnboardingFields(store.state),
    statePath: store.filePath,
    onboardingCompleted: store.state.onboardingCompleted === true
  };
}

function runOnboardingIfNeeded() {
  if (store.state.onboardingCompleted) return false;

  const win = createSettingsWindow();
  win.show();
  win.focus();

  const payload = onboardingPayload();
  // L'événement part vers le shell (trame principale) qui le relaie à l'iframe
  // du panneau natif ; le panneau vérifie de toute façon `onboarding:status`.
  const push = () => sendTo(win, 'trigger-onboarding', payload);

  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', push);
  else push();

  console.log('[onboarding] onboardingCompleted=false → réglages ouverts + trigger-onboarding');
  return true;
}

const PATCHABLE_SCALARS = ['avatarName', 'userName', 'geminiApiKey', 'coreDirectives', 'onboardingCompleted'];
const PATCHABLE_OBJECTS = {
  engines: ['reasoning', 'voice', 'model', 'voiceName', 'temperature', 'maxOutputTokens', 'contextExchanges'],
  avatar: ['x', 'y', 'width', 'height', 'opacity', 'micEnabled', 'clickThroughDefault', 'body'],
  tts: ['enabled', 'host', 'port', 'pythonPath', 'hostScript', 'spawn', 'voiceName', 'voices'],
  settings: ['x', 'y', 'width', 'height']
};

function sanitizePatch(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const key of PATCHABLE_SCALARS) {
    if (raw[key] === true || raw[key] === false) out[key] = raw[key];
    else if (raw[key] != null) out[key] = String(raw[key]).slice(0, 12000);
  }
  for (const [key, fields] of Object.entries(PATCHABLE_OBJECTS)) {
    if (!raw[key] || typeof raw[key] !== 'object') continue;
    const obj = {};
    for (const field of fields) {
      if (raw[key][field] !== undefined && raw[key][field] !== null) obj[field] = raw[key][field];
    }
    if (Object.keys(obj).length) out[key] = obj;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* IPC                                                                        */
/* -------------------------------------------------------------------------- */

function registerIpc() {
  /* ---------------- Click-through (canal de la tâche 1) ---------------- */
  ipcMain.on('set-ignore-mouse-events', (event, ignore) => {
    if (!alive(avatarWindow) || event.sender !== avatarWindow.webContents) return;
    const value = ignore !== false; // toute valeur ≠ false => on ignore la souris
    applyIgnoreMouseEvents(value, { force: true });
    if (!value) clickThrough.graceUntil = Date.now() + 400;
  });

  ipcMain.on('avatar:interactive-lock', (event, locked) => {
    clickThrough.interactiveLocked = locked === true;
    applyIgnoreMouseEvents(!clickThrough.interactiveLocked, { force: true });
    broadcast('click-through:locked', clickThrough.interactiveLocked);
  });

  /* ---------------- Déplacement / taille de l'avatar ---------------- */
  ipcMain.on('avatar:drag-start', (event, point = {}) => {
    if (!alive(avatarWindow)) return;
    const [x, y] = avatarWindow.getPosition();
    dragContext = { winX: x, winY: y, startX: Number(point.x) || 0, startY: Number(point.y) || 0 };
  });

  ipcMain.on('avatar:drag-move', (event, point = {}) => {
    if (!alive(avatarWindow) || !dragContext) return;
    const dx = (Number(point.x) || 0) - dragContext.startX;
    const dy = (Number(point.y) || 0) - dragContext.startY;
    avatarWindow.setPosition(Math.round(dragContext.winX + dx), Math.round(dragContext.winY + dy));
  });

  ipcMain.on('avatar:drag-end', () => {
    if (!alive(avatarWindow)) return;
    dragContext = null;
    const [x, y] = avatarWindow.getPosition();
    store.patch({ avatar: { x, y } });
  });

  ipcMain.handle('avatar:resize', (event, payload = {}) => {
    if (!alive(avatarWindow)) return null;
    const [w, h] = avatarWindow.getSize();
    const aspect = Number(payload.aspect) > 0 ? Number(payload.aspect) : h / w || AVATAR_ASPECT_HEAD;

    let width;
    if (Number(payload.w) > 0) width = Number(payload.w);
    else width = w * (Number(payload.deltaY) > 0 ? 0.94 : 1.06);

    width = Math.round(clampNumber(width, AVATAR_MIN_W, AVATAR_MAX_W, w));
    const height = Math.round(width * aspect);

    const hasX = Number.isFinite(Number(payload.x));
    const hasY = Number.isFinite(Number(payload.y));
    if (hasX || hasY) {
      const [cx, cy] = avatarWindow.getPosition();
      avatarWindow.setBounds({
        x: hasX ? Math.round(Number(payload.x)) : cx,
        y: hasY ? Math.round(Number(payload.y)) : cy,
        width,
        height
      }, false);
    } else {
      avatarWindow.setSize(width, height, false);
    }

    const [x, y] = avatarWindow.getPosition();
    store.patch({ avatar: { width, height, x, y } });
    return { width, height, x, y };
  });

  ipcMain.handle('avatar:reposition', () => recenterAvatar());

  ipcMain.handle('avatar:set-opacity', (event, value) => {
    const opacity = clampNumber(value, 0.2, 1, 1);
    if (alive(avatarWindow)) avatarWindow.setOpacity(opacity);
    store.patch({ avatar: { opacity } });
    return opacity;
  });

  /* ---------------- Réglages : déplacement / taille ---------------- */
  ipcMain.on('settings:drag-start', (event, point = {}) => {
    if (!alive(settingsWindow)) return;
    const [x, y] = settingsWindow.getPosition();
    dragContext = { winX: x, winY: y, startX: Number(point.x) || 0, startY: Number(point.y) || 0 };
  });

  ipcMain.on('settings:drag-move', (event, point = {}) => {
    if (!alive(settingsWindow) || !dragContext) return;
    const dx = (Number(point.x) || 0) - dragContext.startX;
    const dy = (Number(point.y) || 0) - dragContext.startY;
    settingsWindow.setPosition(Math.round(dragContext.winX + dx), Math.round(dragContext.winY + dy));
  });

  ipcMain.on('settings:drag-end', () => {
    if (!alive(settingsWindow) || !dragContext) {
      dragContext = null;
      return;
    }
    dragContext = null;
    const [x, y] = settingsWindow.getPosition();
    const [width, height] = settingsWindow.getSize();
    store.patch({ settings: { x, y, width, height } });
  });

  ipcMain.handle('settings:resize', (event, size = {}) => {
    if (!alive(settingsWindow)) return null;
    const [w, h] = settingsWindow.getSize();
    const width = Math.round(Math.max(SETTINGS_MIN.width, Number(size.w) || w));
    const height = Math.round(Math.max(SETTINGS_MIN.height, Number(size.h) || h));
    settingsWindow.setSize(width, height, false);
    store.patch({ settings: { width, height } });
    return { width, height };
  });

  ipcMain.handle('settings:toggle', (event, visible) => toggleSettingsWindow(visible));
  ipcMain.handle('settings:close', () => {
    if (alive(settingsWindow)) settingsWindow.hide();
    return false;
  });

  /* ---------------- Menu contextuel de l'avatar ---------------- */
  ipcMain.on('app:menu', (event) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Réglages…', accelerator: SHORTCUT_TOGGLE_SETTINGS, click: () => toggleSettingsWindow(true) },
      { label: 'Recentrer l’avatar', click: () => recenterAvatar() },
      { type: 'separator' },
      { label: 'Recharger l’avatar', click: () => alive(avatarWindow) && avatarWindow.reload() },
      { label: 'Masquer l’avatar', click: () => alive(avatarWindow) && avatarWindow.hide() },
      { type: 'separator' },
      { label: 'Quitter Sarra', accelerator: SHORTCUT_QUIT, click: () => quitApp() }
    ]);
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender) || undefined });
  });

  ipcMain.handle('avatar:recenter', () => recenterAvatar());

  /* ---------------- TTS ---------------- */
  // `sendSync` : l'app lit `DESKTOP.voices` de façon synchrone au chargement.
  ipcMain.on('tts:voices-sync', (event) => {
    event.returnValue = (tts && tts.voices.length ? tts.voices : store.state.tts.voices || []).slice();
  });

  ipcMain.on('tts:speak', (event, payload = {}) => {
    if (!tts || !tts.available) {
      // Mode silencieux : on répond quand même `end` pour ne pas bloquer le lipsync.
      setTimeout(() => broadcast('tts:event', { id: payload.id, type: 'end', charIndex: 0 }), 120);
      return;
    }
    tts.speak(payload);
  });

  ipcMain.on('tts:stop', () => tts && tts.stop());

  ipcMain.handle('tts:restart', () => {
    startTts();
    return tts ? tts.getStatus() : ttsStatus;
  });
  ipcMain.handle('tts:status', () => (tts ? tts.getStatus() : ttsStatus));

  // Voix en ligne (Gemini/Edge/ElevenLabs) : non implémenté ici, l'app retombe
  // automatiquement sur la voix Windows quand `ok:false`.
  ipcMain.handle('tts:audio', async () => ({
    ok: false,
    error: "Voix en ligne indisponible dans cette version : la voix Windows de l'hôte Python est utilisée."
  }));

  /* ---------------- IA : Gemini / Groq ---------------- */
  ipcMain.handle('ai:generate', async (event, payload = {}) => {
    try {
      const result = await gemini.generateResponse({
        provider: payload.provider,
        apiKey: String(payload.key || '').trim() || undefined,
        model: payload.model,
        prompt: payload.prompt,
        directive: payload.directive,
        history: Array.isArray(payload.history) ? payload.history : null,
        state: store.state
      });

      // Mémoire persistante : chaque échange rejoint state.json
      store.addExchange(payload.prompt, result.text);
      broadcast('chat:exchange', { prompt: payload.prompt, reply: result.text, ts: Date.now() });

      return {
        ok: true,
        text: result.text,
        provider: result.provider || payload.provider || 'gemini',
        model: result.model,
        latencyMs: result.latencyMs || null,
        memoryTurns: Math.min(10, Math.ceil(store.state.chatHistory.length / 2))
      };
    } catch (err) {
      logError('ai:generate', err);
      return { ok: false, error: err.message, status: err.status || null, code: err.code || null };
    }
  });

  ipcMain.handle('ai:test-key', async (event, payload = {}) => {
    const provider = payload.provider === 'groq' ? 'groq' : 'gemini';
    const key = String(payload.key || '').trim();
    if (!key) return { ok: false, message: 'Clé absente.' };
    try {
      if (provider === 'groq') {
        const res = await gemini.callGroq({ apiKey: key, state: { engines: { model: gemini.GROQ_DEFAULT_MODEL } }, userMessage: 'Ping' });
        return { ok: true, message: `Groq accessible (${res.model}).` };
      }
      const res = await gemini.testConnection({ apiKey: key });
      return { ok: true, message: `Gemini accessible (${res.model}) en ${res.latencyMs} ms.` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  /* ---------------- VRM : retour de chargement ---------------- */
  ipcMain.on('vrm:result', (event, result = {}) => {
    if (!result || typeof result !== 'object') return;
    defaultVrmReported = true;
    if (result.ok) console.log(`[vrm] ${result.name} chargé dans l'avatar`);
    else console.warn(`[vrm] échec (${result.name}) : ${result.error}`);
    // La fenêtre Réglages affiche le résultat de son propre import
    sendTo(settingsWindow, 'vrm:load-result', result);
    sendTo(avatarWindow, 'vrm:status', { ok: result.ok === true, name: result.name, error: result.error || null });
  });

  ipcMain.on('avatar:startup-status', (event, state) => {
    if (!alive(avatarWindow) || event.sender !== avatarWindow.webContents) return;
    if (state === 'complete' || state === 'error' || state === 'missing') {
      avatarStartupState = state;
      showAvatarAfterStartup();
    }
  });

  /* ---------------- Gemini Live (conversation directe) ---------------- */
  ipcMain.handle('live:start', async (event, payload = {}) => {
    if (!liveManager) return { ok: false, error: 'Gestionnaire Gemini Live indisponible.' };

    const key = String(payload.key || store.state.geminiApiKey || '').trim();
    if (!key) {
      return { ok: false, error: "Clé API Gemini manquante : renseignez-la dans les Réglages (Ctrl+Shift+K)." };
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    const owner = event.sender.id;

    const instruction = composeLiveInstruction({
      appInstruction: payload.instruction,
      state: store.state,
      exchanges: (store.state.engines && store.state.engines.contextExchanges) || 10
    });

    // Les premiers événements (`ready`) peuvent arriver avant que `start()` ne
    // rende son sessionId : le tampon local les capture quand même.
    const turnBuffer = { owner, input: '', output: [] };

    const result = await liveManager.start({
      key,
      model: payload.model,
      voice: payload.voice || (store.state.engines && store.state.engines.voiceName) || undefined,
      instruction,
      owner,
      emit: (liveEvent) => {
        // 1) relais vers la fenêtre demandeuse
        liveEmitTo(win, liveEvent);

        // 2) mémoire persistante : on assemble le tour à partir des transcriptions
        const session = liveSessions.get(liveEvent.sessionId) || turnBuffer;
        if (liveEvent.type === 'input-text' && liveEvent.finished && liveEvent.text) {
          session.input = liveEvent.text;
        }
        if (liveEvent.type === 'text' && liveEvent.text) {
          session.output = session.output || [];
          session.output.push(liveEvent.text);
        }
        if (liveEvent.type === 'turn-complete') commitLiveTurn(liveEvent.sessionId, session);
        if (liveEvent.type === 'closed') {
          commitLiveTurn(liveEvent.sessionId, session, true);
          liveSessions.delete(liveEvent.sessionId);
        }
      }
    });

    if (result && result.ok) {
      liveSessions.set(result.sessionId, turnBuffer);
      console.log(`[live] session ${result.sessionId} (${result.model}/${result.voice})`);
    }
    return result;
  });

  ipcMain.on('live:stop', (event, payload = {}) => {
    if (!liveManager) return;
    if (payload.sessionId) {
      commitLiveTurn(payload.sessionId, null, true);
      liveSessions.delete(payload.sessionId);
      liveManager.stop(payload.sessionId);
    } else {
      liveManager.stopOwner(event.sender.id);
      for (const [sessionId, session] of liveSessions) {
        if (session.owner === event.sender.id) {
          commitLiveTurn(sessionId, null, true);
          liveSessions.delete(sessionId);
        }
      }
    }
  });

  ipcMain.on('live:audio', (event, payload = {}) => {
    if (!liveManager || !payload.sessionId) return;
    liveManager.sendAudio(payload.sessionId, payload.data, payload.mimeType);
  });

  ipcMain.on('live:audio-end', (event, payload = {}) => {
    if (!liveManager || !payload.sessionId) return;
    liveManager.sendAudioEnd(payload.sessionId);
  });

  ipcMain.on('live:text', (event, payload = {}) => {
    if (!liveManager || !payload.sessionId) return;
    liveManager.sendText(payload.sessionId, payload.text);
  });

  ipcMain.on('live:tool-response', (event, payload = {}) => {
    if (!liveManager || !payload.sessionId) return;
    liveManager.sendToolResponse(payload.sessionId, payload.toolCallId, payload.name, payload.response);
  });

  ipcMain.handle('live:status', () => ({
    sessions: Array.from(liveSessions.keys()),
    available: Boolean(liveManager)
  }));

  /* ---------------- État / onboarding ---------------- */
  const fullStateFor = (event) => {
    const isSettings = alive(settingsWindow) && event.sender === settingsWindow.webContents;
    return isSettings ? store.state : store.redacted();
  };

  ipcMain.handle('state:get', (event) => fullStateFor(event));

  ipcMain.handle('state:save', (event, patch) => {
    store.patch(sanitizePatch(patch));
    broadcast('state:updated', store.redacted());
    return currentStateView(event);
  });

  ipcMain.handle('state:save-defaults', async (event, patch = {}) => {
    store.patch(sanitizePatch(patch), { persist: false });
    const complete = hasRequiredOnboardingFields(store.state);
    if (complete) store.patch({ onboardingCompleted: true }, { persist: false });
    await store.saveNow();

    const payload = {
      ok: true,
      statePath: store.filePath,
      savedAt: store.state.updatedAt,
      onboardingCompleted: store.state.onboardingCompleted,
      missing: missingOnboardingFields(store.state)
    };
    broadcast('state:saved', payload);
    broadcast('state:updated', store.redacted());
    broadcast('onboarding:completed', { ok: complete });
    return payload;
  });

  function currentStateView(event) {
    return fullStateFor(event);
  }

  ipcMain.handle('onboarding:status', () => onboardingPayload());

  ipcMain.handle('onboarding:complete', async () => {
    if (!hasRequiredOnboardingFields(store.state)) {
      return { ok: false, missing: missingOnboardingFields(store.state) };
    }
    store.patch({ onboardingCompleted: true }, { persist: false });
    await store.saveNow();
    broadcast('onboarding:completed', { ok: true });
    return { ok: true };
  });

  ipcMain.handle('history:get', (event, limit = 200) =>
    store.state.chatHistory.slice(-Math.round(clampNumber(limit, 1, 400, 200)))
  );

  ipcMain.handle('history:clear', async () => {
    store.clearHistory();
    await store.saveNow();
    broadcast('history:cleared', { ok: true });
    return { ok: true };
  });

  /* ---------------- Application ---------------- */
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    statePath: store.filePath,
    baseUrl,
    appUrl: appUrl(),
    tts: tts ? tts.getStatus() : ttsStatus,
    shortcuts: {
      toggleSettings: SHORTCUT_TOGGLE_SETTINGS,
      interactiveLock: SHORTCUT_INTERACTIVE_LOCK,
      quit: SHORTCUT_QUIT
    }
  }));

  ipcMain.handle('app:open-external', (event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('app:quit', () => {
    quitApp();
    return true;
  });

  ipcMain.handle('app:reload', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.reload();
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Raccourcis globaux                                                         */
/* -------------------------------------------------------------------------- */

function registerShortcuts() {
  const register = (accelerator, handler, label) => {
    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (!ok) console.warn(`[shortcut] ${label} (${accelerator}) déjà utilisé par une autre application`);
      return ok;
    } catch (err) {
      logError(`shortcut:${label}`, err);
      return false;
    }
  };

  // Tâche 3 : Ctrl+Shift+K affiche/masque les réglages (toggle)
  register(SHORTCUT_TOGGLE_SETTINGS, () => toggleSettingsWindow(), 'settings');
  register(SHORTCUT_INTERACTIVE_LOCK, () => {
    clickThrough.interactiveLocked = !clickThrough.interactiveLocked;
    applyIgnoreMouseEvents(!clickThrough.interactiveLocked, { force: true });
    broadcast('click-through:locked', clickThrough.interactiveLocked);
  }, 'interactive');
  register(SHORTCUT_QUIT, () => quitApp(), 'quit');
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

/* -------------------------------------------------------------------------- */
/* Cycle de vie                                                               */
/* -------------------------------------------------------------------------- */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    toggleSettingsWindow(true);
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    createSplashWindow();

    // Micro (getUserMedia dans l'iframe) : on autorise uniquement nos pages locales.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      const url = wc.getURL() || '';
      const trusted = baseUrl ? url.startsWith(baseUrl) : false;
      callback(permission === 'media' && trusted);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

    store.load();

    try {
      await startServer();
    } catch (err) {
      logError('server', err);
      closeSplashWindow();
      dialog.showErrorBox('Sarra', `Impossible de démarrer le serveur local : ${err.message}`);
      app.quit();
      return;
    }

    registerIpc();
    initLive();

    createAvatarWindow();
    createSettingsWindow();  // créée mais `show: false`
    startHitTestWatcher();
    startTts();
    registerShortcuts();

    runOnboardingIfNeeded();

    app.on('activate', () => {
      if (!alive(avatarWindow)) createAvatarWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    closeSplashWindow();
    stopHitTestWatcher();
    stopTts();
    if (liveManager) {
      for (const sessionId of Array.from(liveSessions.keys())) commitLiveTurn(sessionId, null, true);
      try {
        liveManager.closeAll();
      } catch (_) {
        /* ignore */
      }
      liveManager = null;
    }
    if (server) {
      try {
        server.close();
      } catch (_) {
        /* ignore */
      }
      server = null;
    }
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') quitApp();
  });
}

module.exports = { sanitizePatch, missingOnboardingFields };
