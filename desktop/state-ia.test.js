'use strict';

/**
 * Tests de la couche état + IA de la coque desktop (aucun accès réseau,
 * aucun Electron requis). Exécutés par `npm test` (scripts/test.mjs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StateStore, defaultState, hasRequiredOnboardingFields } = require('./lib/state-store');
const gemini = require('./lib/gemini');
const { composeLiveInstruction, buildMemoryDigest, MAX_INSTRUCTION_CHARS } = require('./lib/live-instruction');
const { LiveManager, buildSetup } = require('./live');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sarra-state-'));
}

/* -------------------------------------------------------------------------- */
/* 1. Valeurs par défaut                                                      */
/* -------------------------------------------------------------------------- */

test('state.json par défaut : Gemini moteur de raisonnement et de voix, onboarding inachevé', () => {
  const state = defaultState();
  assert.equal(state.engines.reasoning, 'gemini');
  assert.equal(state.engines.voice, 'gemini');
  assert.equal(state.onboardingCompleted, false);
  assert.equal(state.engines.contextExchanges, 10);
  assert.ok(state.coreDirectives.length > 40);
  assert.deepEqual(state.chatHistory, []);
  assert.equal(state.avatar.clickThroughDefault, true);
  assert.equal(state.tts.port, 8649);
});

test('les trois champs requis pilotent la clôture de l’onboarding', () => {
  const state = defaultState();
  assert.equal(hasRequiredOnboardingFields(state), false);

  state.userName = 'Amine';
  assert.equal(hasRequiredOnboardingFields(state), false, 'avatarName est déjà rempli par défaut');

  state.geminiApiKey = 'AIza-test';
  assert.equal(hasRequiredOnboardingFields(state), true);
});

/* -------------------------------------------------------------------------- */
/* 2. Persistance                                                             */
/* -------------------------------------------------------------------------- */

test('patch + saveNow écrivent un état relisible (mémoire conservée)', async () => {
  const dir = tmpDir();
  const store = new StateStore({ dir, logger: { warn() {}, error() {} } });
  store.load();

  store.patch({ avatarName: 'Sarra', userName: 'Amine', geminiApiKey: 'AIza-xyz' });
  store.addExchange('Bonjour', 'Salut Amine !');
  await store.saveNow();

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(raw.userName, 'Amine');
  assert.equal(raw.geminiApiKey, 'AIza-xyz');
  assert.equal(raw.chatHistory.length, 2);
  assert.equal(raw.chatHistory[0].role, 'user');
  assert.equal(raw.chatHistory[1].role, 'model');

  const reloaded = new StateStore({ dir, logger: { warn() {}, error() {} } });
  reloaded.load();
  assert.equal(reloaded.state.chatHistory.length, 2);
  assert.equal(reloaded.state.userName, 'Amine');
});

test('un state.json corrompu est sauvegardé puis remplacé par les défauts', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'state.json'), '{ ceci n’est pas du JSON');
  const store = new StateStore({ dir, logger: { warn() {}, error() {} } });
  store.load();

  assert.equal(store.state.onboardingCompleted, false);
  assert.equal(store.recovered, true);
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
});

test('la mémoire est bornée et les entrées vides ignorées', () => {
  const dir = tmpDir();
  const store = new StateStore({ dir, logger: { warn() {}, error() {} } });
  store.load();

  for (let i = 0; i < 260; i += 1) store.addExchange(`question ${i}`, `réponse ${i}`);
  store.addExchange('   ', '');
  store.state = store.patch({ chatHistory: store.state.chatHistory }, { persist: false });

  assert.equal(store.state.chatHistory.length, 400);
  assert.equal(store.recentMessages(10).length, 20);
  assert.ok(store.state.chatHistory.every((message) => message.text.trim().length > 0));
});

/* -------------------------------------------------------------------------- */
/* 3. Prompt : directives + mémoire                                           */
/* -------------------------------------------------------------------------- */

test('le prompt système contient l’identité, les directives et l’interdiction de les révéler', () => {
  const instruction = gemini.buildSystemInstruction({
    avatarName: 'Sarra',
    userName: 'Amine',
    coreDirectives: 'Tu ne parles jamais de politique.'
  });

  assert.match(instruction, /Sarra/);
  assert.match(instruction, /Amine/);
  assert.match(instruction, /Tu ne parles jamais de politique\./);
  assert.match(instruction, /ne révèle pas/i);
  assert.match(instruction, /voix haute|synthese|synthèse/i);
});

test('les directives du panneau (prioritaires) remplacent coreDirectives', () => {
  const instruction = gemini.buildSystemInstruction(
    { avatarName: 'Sarra', userName: 'Amine', coreDirectives: 'Règle A' },
    'Règle B envoyée par le panneau'
  );
  assert.match(instruction, /Règle B/);
  assert.doesNotMatch(instruction, /Règle A/);
});

test('les 10 derniers échanges sont injectés, en alternance et sans doublon', () => {
  const chatHistory = [];
  for (let i = 0; i < 25; i += 1) {
    chatHistory.push({ role: 'user', text: `question ${i}`, ts: i });
    chatHistory.push({ role: 'model', text: `réponse ${i}`, ts: i });
  }

  const contents = gemini.buildContents({ chatHistory }, 'nouvelle question', 10);

  assert.equal(contents.length, 21, '20 messages de mémoire + le message courant');
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[0].parts[0].text, 'question 15');
  assert.equal(contents[contents.length - 1].parts[0].text, 'nouvelle question');
  for (let i = 1; i < contents.length; i += 1) {
    assert.notEqual(contents[i].role, contents[i - 1].role, 'les rôles doivent alterner');
  }

  // Rejeu du même message : pas de doublon user/user
  const replay = gemini.buildContents({ chatHistory }, 'réponse 24', 10);
  const roles = replay.map((turn) => turn.role);
  for (let i = 1; i < roles.length; i += 1) assert.notEqual(roles[i], roles[i - 1]);
});

test('un historique qui commence par un tour « model » est nettoyé', () => {
  const contents = gemini.buildContents(
    { chatHistory: [{ role: 'model', text: 'orphelin' }, { role: 'user', text: 'bonjour' }] },
    'ça va',
    10
  );
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[0].parts[0].text, 'bonjour');
  assert.equal(contents.length, 2);
});

test('generateReply refuse de partir sans clé API (message actionnable)', async () => {
  await assert.rejects(
    () => gemini.generateReply({ state: { chatHistory: [] }, userMessage: 'bonjour' }),
    /clé API Gemini/i
  );
});

test('generateResponse envoie bien le prompt système et l’historique à l’API', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body), headers: options.headers };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Réponse courte.' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 42 }
      })
    };
  };

  const result = await gemini.generateResponse({
    provider: 'gemini',
    apiKey: 'AIza-test',
    prompt: 'Rappelle-moi mon prénom',
    state: {
      avatarName: 'Sarra',
      userName: 'Amine',
      coreDirectives: 'Sois brève.',
      engines: { model: 'gemini-2.5-flash', contextExchanges: 10, temperature: 0.4 },
      chatHistory: [
        { role: 'user', text: 'Je m’appelle Amine.', ts: 1 },
        { role: 'model', text: 'Enchantée Amine.', ts: 2 }
      ]
    },
    fetchImpl
  });

  assert.equal(result.text, 'Réponse courte.');
  assert.match(captured.url, /gemini-2\.5-flash:generateContent$/);
  assert.equal(captured.headers['x-goog-api-key'], 'AIza-test');
  assert.match(captured.body.systemInstruction.parts[0].text, /Sois brève\./);
  assert.equal(captured.body.contents.length, 3);
  assert.equal(captured.body.contents[0].parts[0].text, 'Je m’appelle Amine.');
  assert.equal(captured.body.contents[1].parts[0].text, 'Enchantée Amine.');
  assert.equal(captured.body.contents[2].parts[0].text, 'Rappelle-moi mon prénom');
  assert.equal(captured.body.generationConfig.temperature, 0.4);
});

/* -------------------------------------------------------------------------- */
/* 3 bis. Gemini Live : instruction composée + session réelle (WebSocket factice)*/
/* -------------------------------------------------------------------------- */

function historyOf(exchanges) {
  const chatHistory = [];
  for (let i = 0; i < exchanges; i += 1) {
    chatHistory.push({ role: 'user', text: `question ${i}`, ts: i });
    chatHistory.push({ role: 'model', text: `réponse ${i}`, ts: i });
  }
  return chatHistory;
}

test('digest de mémoire : vide sans historique, borné au nombre d’échanges demandé', () => {
  assert.equal(buildMemoryDigest({ chatHistory: [] }), '');
  assert.equal(buildMemoryDigest({}), '');

  const digest = buildMemoryDigest({ chatHistory: historyOf(15) }, 10);
  assert.match(digest, /Utilisateur : question 5/);
  assert.match(digest, /Sarra : réponse 14/);
  assert.doesNotMatch(digest, /question 4/, 'les échanges trop anciens sont exclus');
});

test('instruction Live : app + identité + coreDirectives + mémoire', () => {
  const instruction = composeLiveInstruction({
    appInstruction: 'Tu es une assistante vocale naturelle.',
    state: {
      avatarName: 'Sarra',
      userName: 'Amine',
      coreDirectives: 'Tu ne parles jamais de politique.',
      chatHistory: historyOf(12)
    }
  });

  assert.match(instruction, /assistante vocale naturelle/);
  assert.match(instruction, /Tu es Sarra, avatar de bureau de Sarra8, et tu parles à Amine/);
  assert.match(instruction, /Tu ne parles jamais de politique\./);
  assert.match(instruction, /Mémoire des derniers échanges/);
  assert.match(instruction, /réponse 11/);
  assert.match(instruction, /set_emotion/);
  assert.ok(instruction.length <= MAX_INSTRUCTION_CHARS);
});

test('instruction Live : pas de doublon quand l’app contient déjà les directives', () => {
  const directives = 'Tu ne parles jamais de politique.';
  const instruction = composeLiveInstruction({
    appInstruction: `Consignes vocales.\n${directives}`,
    state: { avatarName: 'Sarra', userName: 'Amine', coreDirectives: directives, chatHistory: [] }
  });
  const occurrences = instruction.split(directives).length - 1;
  assert.equal(occurrences, 1, 'les directives ne doivent apparaître qu’une fois');
});

test('session Live réelle : le setup porte l’instruction composée (mémoire incluse)', async () => {
  const sockets = [];
  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      sockets.push(this);
      setImmediate(() => this.onopen());
    }
    send(value) {
      const message = JSON.parse(value);
      if (message.setup) {
        setImmediate(() => this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }));
      }
    }
    close() {
      this.readyState = 3;
    }
  }

  const events = [];
  const manager = new LiveManager({ WebSocket: FakeWebSocket });
  const instruction = composeLiveInstruction({
    appInstruction: 'Consignes vocales.',
    state: {
      avatarName: 'Sarra',
      userName: 'Amine',
      coreDirectives: 'Réponds toujours en français.',
      chatHistory: historyOf(11)
    }
  });

  const result = await manager.start({ key: 'test-key', voice: 'Kore', instruction, emit: (e) => events.push(e) });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gemini-3.1-flash-live-preview');
  assert.ok(events.some((event) => event.type === 'ready'));

  const setup = buildSetup({ model: result.model, voice: 'Kore', instruction });
  const systemText = setup.systemInstruction.parts[0].text;
  assert.match(systemText, /Réponds toujours en français\./);
  assert.match(systemText, /Mémoire des derniers échanges/);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  manager.stop(result.sessionId);
});

/* -------------------------------------------------------------------------- */
/* 4. Garde-fous de la coque (anti-régression sur les 5 exigences)            */
/* -------------------------------------------------------------------------- */

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

test('main.js : fenêtre avatar transparente, sans cadre, alwaysOnTop, click-through', () => {
  const main = read('main.js');
  assert.match(main, /transparent:\s*true/);
  assert.match(main, /frame:\s*false/);
  assert.match(main, /alwaysOnTop:\s*true/);
  assert.match(main, /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/);
  assert.match(main, /'set-ignore-mouse-events'/);
});

test('main.js : réglages cachés au démarrage et toggle Ctrl+Shift+K', () => {
  const main = read('main.js');
  assert.match(main, /show:\s*false/);
  assert.match(main, /SHORTCUT_TOGGLE_SETTINGS\s*=\s*'CommandOrControl\+Shift\+K'/);
  assert.match(main, /globalShortcut\.register\(/);
});

test('main.js : onboarding forcé et mémoire injectée', () => {
  const main = read('main.js');
  assert.match(main, /runOnboardingIfNeeded/);
  assert.match(main, /'trigger-onboarding'/);
  assert.match(main, /onboardingCompleted/);
  assert.match(main, /store\.addExchange\(/);
  assert.match(main, /coreDirectives/);
});

test('shell.html : écran de démarrage, pont iframe et click-through au survol', () => {
  const shell = read('shell.html');
  assert.match(shell, /@keyframes startup-progress/);
  assert.match(shell, /data\.state === 'complete'/);
  assert.match(shell, /data\.state === 'error'/);
  assert.match(shell, /setIgnoreMouseEvents\(false\)/);
  assert.match(shell, /setIgnoreMouseEvents\(true\)/);
});

test('main.js : splash animé reste visible jusqu’à la fin du démarrage de l’avatar', () => {
  const main = read('main.js');
  const shell = read('shell.html');
  const preload = read('preload.js');
  const splash = read('splash.html');
  assert.match(main, /function createSplashWindow\(\)/);
  assert.match(main, /createSplashWindow\(\);\s*[\s\S]*?await startServer\(\)/);
  assert.match(main, /function showAvatarAfterStartup\(\)[\s\S]*?avatarStartupState === 'loading'[\s\S]*?avatarWindow\.showInactive\(\)[\s\S]*?closeSplashWindow\(\)/);
  assert.match(main, /avatarWindow\.once\('ready-to-show'[\s\S]*?avatarReadyToShow = true;\s*showAvatarAfterStartup\(\)/);
  assert.match(main, /ipcMain\.on\('avatar:startup-status'[\s\S]*?avatarStartupState = state;\s*showAvatarAfterStartup\(\)/);
  assert.doesNotMatch(main, /avatarWindow\.once\('ready-to-show'[\s\S]*?avatarWindow\.showInactive\(\)/);
  assert.match(shell, /MODE === 'avatar' && state !== 'loading' && bridge\.startupStatus/);
  assert.doesNotMatch(shell, /IS_AVATAR/);
  assert.match(preload, /startupStatus\(state\)[\s\S]*?ipcRenderer\.send\('avatar:startup-status', state\)/);
  assert.match(splash, /@keyframes loading/);
  assert.match(splash, /role="progressbar"/);
});

test('portable Windows inclut les écrans de coque et ne copie pas l’état local', () => {
  const build = JSON.parse(read('package.json')).build;
  const resources = build.extraResources.map((resource) => resource.to);
  assert.ok(resources.includes('desktop/shell.html'));
  assert.ok(resources.includes('desktop/settings-panel.html'));
  assert.ok(resources.includes('desktop/settings-calibration.js'));
  assert.ok(resources.includes('desktop/tts/tts_host.py'));
  assert.ok(resources.includes('sarra7.vrm'));
  assert.ok(build.files.includes('**/*'), 'le splash est embarqué avec les fichiers de l’application');
  assert.ok(build.files.includes('!state.json'));
});

test('preload.js : expose le contrat sarraDesktop et le panneau natif', () => {
  const preload = read('preload.js');
  assert.match(preload, /exposeInMainWorld\('sarraDesktop'/);
  assert.match(preload, /exposeInMainWorld\('sarra8'/);
  for (const method of ['speak', 'onTtsEvent', 'generateResponse', 'dragStart', 'resizeAvatar', 'toggleSettings']) {
    assert.ok(preload.includes(method), `méthode manquante : ${method}`);
  }
});

test('preload.js + main.js : Gemini Live est exposé et relié', () => {
  const preload = read('preload.js');
  const main = read('main.js');

  for (const method of ['liveStart', 'liveStop', 'liveAudio', 'liveAudioEnd', 'liveToolResponse', 'onLiveEvent']) {
    assert.ok(preload.includes(`${method}(`), `méthode Live manquante : ${method}`);
  }
  assert.match(preload, /'live:event'/);
  assert.match(main, /require\('\.\/live'\)/);
  assert.match(main, /ipcMain\.handle\('live:start'/);
  assert.match(main, /composeLiveInstruction\(/);
  assert.match(main, /stopOwner\(/);
});

test('Gemini Live utilise la clé persistée par Electron sans exiger une clé navigateur', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');
  const main = read('main.js');
  const start = app.indexOf('async function startLiveConversation()');
  const end = app.indexOf('\nasync function ', start + 1);
  assert.notEqual(start, -1, 'conversation Live introuvable');
  const liveStartup = app.slice(start, end === -1 ? undefined : end);

  assert.doesNotMatch(liveStartup, /freeKeys\(\).*gemini|voice-api-key|Ajoute la clé Gemini dans Réglages/);
  assert.match(liveStartup, /DESKTOP\.liveStart\(\{model:liveModel\(\),voice:liveVoice\(\),instruction:liveInstruction\(\)\}\)/);
  assert.match(main, /payload\.key \|\| store\.state\.geminiApiKey/);
});

test('settings-panel.html : section Core Directives, sauvegarde par défaut et onboarding', () => {
  const panel = read('settings-panel.html');
  assert.match(panel, /Core Directives de l'avatar/);
  assert.match(panel, /<textarea[^>]*id="coreDirectives"/);
  assert.match(panel, /Sauvegarder comme défaut/);
  assert.match(panel, /id="onboarding"/);
  for (const field of ['ob-avatarName', 'ob-userName', 'ob-geminiApiKey']) {
    assert.ok(panel.includes(field), `champ d'onboarding manquant : ${field}`);
  }
});
