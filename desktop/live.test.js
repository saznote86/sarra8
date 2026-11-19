'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LiveManager,
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  buildSetup,
} = require('./live');

test('Live setup uses the supported default model and minimal audio payload', () => {
  assert.equal(DEFAULT_MODEL, 'gemini-3.1-flash-live-preview');
  assert.deepEqual(FALLBACK_MODELS, ['gemini-2.5-flash-native-audio-preview-09-2025']);

  const setup = buildSetup({
    model: DEFAULT_MODEL,
    voice: 'Kore',
    instruction: 'Réponds en français.',
  });
  const json = JSON.stringify({ setup });

  assert.equal(setup.model, `models/${DEFAULT_MODEL}`);
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
  assert.equal(setup.systemInstruction.parts[0].text, 'Réponds en français.');
  assert.equal(setup.tools[0].functionDeclarations[0].name, 'set_emotion');
  assert.equal(Object.hasOwn(setup, 'toolConfig'), false);
  assert.deepEqual(setup.realtimeInputConfig, {
    automaticActivityDetection: {
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
      prefixPaddingMs: 120,
      silenceDurationMs: 500,
    },
    activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
  });
  assert.equal(Object.hasOwn(setup, 'contextWindowCompression'), false);
  assert.equal(Object.hasOwn(setup, 'sessionResumption'), false);
  const fallback = buildSetup({ model: DEFAULT_MODEL, voice: 'Kore', instruction: 'x', tuning: false });
  assert.equal(Object.hasOwn(fallback, 'realtimeInputConfig'), false);
  assert.doesNotThrow(() => JSON.parse(json));
});

test('Gemini Live retries without turn tuning when the server rejects the setup', async () => {
  const attempts = [];
  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      setImmediate(() => this.onopen());
    }

    send(value) {
      const message = JSON.parse(value);
      if (!message.setup) return;
      attempts.push(message.setup);
      if (message.setup.realtimeInputConfig) {
        setImmediate(() => this.onclose({
          code: 1007,
          reason: JSON.stringify({ error: { message: 'Invalid JSON payload received. Unknown name "realtimeInputConfig".' } }),
        }));
        return;
      }
      setImmediate(() => this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }));
    }

    close() {
      this.readyState = 3;
    }
  }
  const manager = new LiveManager({ WebSocket: FakeWebSocket });
  const session = await manager.start({ key: 'test-key' });

  assert.equal(session.ok, true);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].realtimeInputConfig);
  assert.equal(Object.hasOwn(attempts[1], 'realtimeInputConfig'), false);
  manager.stop(session.sessionId);
});

test('Gemini Live forwards completed input transcriptions for deterministic avatar commands', async () => {
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
  const session = await manager.start({ key: 'test-key', emit: (event) => events.push(event) });

  assert.equal(session.ok, true);
  sockets[0].onmessage({
    data: JSON.stringify({ serverContent: { inputTranscription: { text: 'Souris' } } }),
  });
  sockets[0].onmessage({
    data: JSON.stringify({ serverContent: { inputTranscription: { text: '-moi' }, turnComplete: true } }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(events.some((event) => event.type === 'input-text' && event.text === 'Souris-moi' && event.finished));
  manager.stop(session.sessionId);
});

test('Electron avatar shell defaults to head framing', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');
  assert.match(html, /const lay=\{[^\n]*body:IS_AVATAR\?0:1/);
  assert.match(html, /if\(IS_AVATAR\)lay\.body=0/);
  assert.match(html, /avatar-head-v5/);
});

test('Electron startup shows animated progress until the default VRM is ready', () => {
  const shell = fs.readFileSync(path.join(__dirname, 'shell.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');
  assert.match(shell, /@keyframes startup-progress/);
  assert.match(shell, /animation: startup-progress 2\.4s ease-in-out infinite/);
  assert.match(shell, /function armStartupTimeout\(\)/);
  assert.match(shell, /}, 30000\)/);
  assert.doesNotMatch(shell, /setTimeout\(\(\) => \{\s*if \(startup\.dataset\.state === 'loading'\) setStartup\('complete'\),\s*6000\)/);
  assert.match(shell, /data\.state === 'complete'/);
  assert.match(shell, /data\.state === 'error'/);
  assert.match(app, /fetch\('sarra7\.vrm'\)/);
  assert.match(app, /notifyStartup\('complete'\)/);
  assert.match(app, /notifyStartup\('error',message\)/);
});

test('bundled clay avatar keeps facial detail, lash alpha, normal maps and authored eyes', async () => {
  const { applyDefaultAvatarAppearance } = await import('./avatar-appearance.mjs');
  const app = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');
  assert.match(app, /if\(bundled\)applyDefaultAvatarAppearance\(model\)/);
  assert.match(app, /import \{applyDefaultAvatarAppearance\} from '\.\/avatar-core\/appearance\.js'/);

  const marker = {};
  const head = {
    name: 'AvatarHead',
    map: marker,
    shadeMultiplyTexture: marker,
    emissiveMap: marker,
    rimMultiplyTexture: marker,
    matcapTexture: marker,
    normalMap: marker,
    color: { set(value) { this.value = value; } },
    shadeColorFactor: { set(value) { this.value = value; } },
    emissive: { set(value) { this.value = value; } },
    metalness: 0.5,
    roughness: 0.2,
  };
  const lashes = { name: 'AvatarEyelashes', map: marker, transparent: true, alphaTest: 0.5 };
  const eyes = { name: 'AvatarLeftEyeball', map: marker, color: { set() { throw new Error('eye color changed'); } } };
  applyDefaultAvatarAppearance({
    scene: { traverse(callback) { callback({ isMesh: true, material: [head, lashes, eyes] }); } },
  });

  for (const property of ['map', 'shadeMultiplyTexture', 'emissiveMap', 'rimMultiplyTexture', 'matcapTexture']) {
    assert.equal(head[property], marker);
  }
  assert.equal(head.normalMap, marker);
  assert.equal(head.color.value, 0xf4f4f4);
  assert.equal(head.shadeColorFactor.value, 0xf4f4f4);
  assert.equal(head.emissive.value, 0x000000);
  assert.equal(head.metalness, 0);
  assert.equal(head.roughness, 0.85);
  assert.equal(lashes.map, marker);
  assert.equal(lashes.transparent, true);
  assert.equal(lashes.alphaTest, 0.5);
  assert.equal(eyes.map, marker);
});

test('Windows launcher starts Electron without leaving a console window open', () => {
  const launcher = fs.readFileSync(path.join(__dirname, 'launch.vbs'), 'utf8');
  const batch = fs.readFileSync(path.join(__dirname, '..', 'start.bat'), 'utf8');
  assert.match(launcher, /shell\.Run command, 0, False/);
  assert.match(batch, /wscript\.exe \/\/NoLogo/);
});

test('Electron avatar can be dragged with the left mouse button without a modifier key', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');
  assert.match(html, /cv\.addEventListener\('pointerdown',e=>\{\s*if\(e\.button!==0\)return;/);
  assert.doesNotMatch(html, /if\(e\.button!==0\|\|!e\.altKey\)return/);
  assert.match(html, /const bounds=cv\.getBoundingClientRect\(\);if\(e\.clientY>=bounds\.top\+bounds\.height\/2\)return;/);
  assert.match(html, /DESKTOP\.dragStart\(\{x:e\.screenX,y:e\.screenY\}\)/);
});

test('avatar microphone toggles voice detection and keeps local listening armed', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');
  assert.match(html, /id="voice-assistant"[^>]*aria-label="Activer le microphone"/);
  assert.match(html, /#voice-assistant-wrap\{[^}]*left:50%;top:min\(70%,calc\(100% ?- ?54px\)\);bottom:auto/);
  assert.match(html, /#voice-assistant::before\{content:'';position:absolute;top:-18px;left:50%;width:2px;height:18px/);
  assert.match(html, /class="mic-slash"/);
  assert.match(html, /button\.setAttribute\('aria-pressed',voiceAssistant\.enabled\?'true':'false'\)/);
  assert.match(html, /if\(rms>\.012\)\{lastVoice=now;live\.lastActivity=now\}/);
  assert.match(html, /if\(!live\.speaking\)\{[\s\S]{0,240}?liveSendSamples\(input\);\s*return;/);
  assert.match(html, /if\(bargeSince&&now-bargeSince>=160\)liveBargeIn\(\)/);
  assert.doesNotMatch(html, /DESKTOP\.liveAudioEnd/);
  assert.match(html, /if\(rms>\.018\)\{localVoice\.heardSpeech=true;localVoice\.lastVoiceAt=now\}/);
  assert.match(html, /function scheduleLocalVoiceDetection\(message\)/);
  assert.match(html, /voiceAssistant\.enabled&&aiEngine\(\)==='ollama'\)scheduleLocalVoiceDetection/);
  assert.doesNotMatch(html, /Parler à Sarra/);
});

test('explicit text emotion requests are applied and routed to the avatar renderer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');
  assert.match(html, /function requestedEmotion\(text\)/);
  assert.match(html, /const emotionRequest=requestedEmotion\(prompt\)/);
  assert.match(html, /applyOllamaEmotionCommand\(\{type:'avatar_emotion',emotion:emotionRequest\.emotion/);
  assert.match(html, /async function handleOllamaPrompt\(prompt,\{voice=false\}=\{\}\)\{\s*const status=[\s\S]*?const emotionRequest=requestedEmotion\(prompt\)/);
  assert.match(html, /if\(voice\)\{localVoice\.processing=false;setVoiceAssistantState\('speaking','🔊 Expression appliquée · réponse vocale'\)\}/);
  assert.match(html, /type:'avatar-emotion-command',requestId,command:/);
  assert.match(html, /if\(d\.type==='avatar-emotion-command'&&typeof d\.requestId==='string'\)/);
  assert.match(html, /avatar-emotion-command-result/);
  assert.match(html, /case 'input-text':\{\s*if\(!event\.finished\|\|!event\.text\)break;/);
  assert.match(html, /const request=requestedEmotion\(event\.text\)/);
});

test('Live lipsync follows the output transcription and emotions decay naturally', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');
  assert.match(html, /function liveTextVisemes\(dtMs\)/);
  assert.match(html, /const text=liveTextVisemes\(dtMs\)/);
  assert.match(html, /live\.visemeCursor=advanceVisemeCursor\(seq,live\.visemeCursor,dtMs\/1000,cfg\.cps,cfg\.rate\)/);
  assert.match(html, /return sampleVisemeTargets\(seq,live\.visemeCursor,cfg\)/);
  assert.match(html, /const textMix=Math\.max\(0,Math\.min\(1,Number\.isFinite\(cfg\.textMix\)\?cfg\.textMix:\.6\)\)/);
  assert.match(html, /function applyAutoEmotion\(emotion,intensity=\.45,hold=3600,source='auto'\)/);
  assert.match(html, /const AUTO_EMOTION_CUES=\[/);
  assert.match(html, /setAvatarEmotion\('neutre',1,700,'auto-decay'\)/);
  assert.match(html, /liveMarkThinking\(\)/);
  assert.match(html, /liveClearThinking\(\)/);
  assert.match(html, /scheduleMicroExpression\(\)/);
});

test('Electron avatar shell no longer displays Screen capture controls', () => {
  const shell = fs.readFileSync(path.join(__dirname, 'shell.html'), 'utf8');
  assert.doesNotMatch(shell, /btn-screen1|screen-result|Screen 1/);
});
