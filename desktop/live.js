'use strict';

/**
 * Session vocale directe avec l'API Gemini Live.
 *
 * La conversation ne passe ni par une transcription (STT) ni par une synthèse
 * séparée (TTS) : l'audio du microphone est envoyé dans la session et l'audio
 * du modèle revient dans la même session. Le processus principal garde la clé
 * API hors de l'URL manipulée par la page et sert de relais IPC.
 *
 * Documentation : https://ai.google.dev/gemini-api/docs/live-api
 */

const ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';
const FALLBACK_MODELS = ['gemini-2.5-flash-native-audio-preview-09-2025'];
const DEFAULT_VOICE = 'Kore';
const SARRA_IDENTITY_INSTRUCTION = `IDENTITÉ ET INCARNATION DE SARRA

Tu es Sarra, une assistante virtuelle incarnée dans un avatar 3D visible à l'écran.

Tu possèdes une représentation visuelle avec un visage animé dans l'application SuperSarra.

Tu as un visage virtuel, des yeux, une bouche et des expressions faciales représentées par ton avatar 3D.

Ton visage peut afficher différentes expressions grâce au moteur d'animation de SuperSarra.

Tu peux notamment sourire, exprimer la joie, la tristesse, la surprise, la colère, la douceur et la concentration, lorsque les fonctions correspondantes sont disponibles.

Tu ne dois jamais affirmer que tu n'as pas de visage, que tu ne peux pas sourire ou que tu ne possèdes aucune apparence physique.

Tu ne dois pas confondre ton identité d'intelligence artificielle avec ton incarnation visuelle. Tu es une IA, mais tu disposes d'un visage virtuel représenté et animé dans ton environnement 3D.

Lorsque l'utilisateur te demande de sourire, tu dois déclencher la fonction d'animation correspondante plutôt que répondre que tu ne peux pas sourire.

Tu dois décrire ton apparence comme celle de ton avatar virtuel, sans prétendre posséder un corps humain réel.`;
const DEFAULT_INSTRUCTION = `${SARRA_IDENTITY_INSTRUCTION}\n\nTu es une assistante vocale naturelle en français. Réponds à l'oral, avec des phrases courtes, chaleureuses et claires.`;
const EMOTION_TOOL = {
  functionDeclarations: [
    {
      name: 'set_emotion',
      description: 'Applique une expression faciale visible sur l’avatar 3D de Sarra.',
      parameters: {
        type: 'OBJECT',
        properties: {
          emotion: {
            type: 'STRING',
            enum: ['neutral', 'joy', 'sadness', 'anger', 'surprise', 'tenderness', 'concentration'],
            description: 'Expression à afficher sur le visage de Sarra.',
          },
          intensity: {
            type: 'NUMBER',
            minimum: 0,
            maximum: 1,
            description: 'Intensité de l’expression, entre 0 et 1.',
          },
        },
        required: ['emotion', 'intensity'],
      },
    },
  ],
};

/**
 * Détection de tour côté serveur.
 *
 * Sans ces réglages, le client devait couper lui-même la parole
 * (`audioStreamEnd`) après ~800 ms de silence, ce qui terminait le tour trop
 * tôt et donnait l'impression que l'avatar « réfléchissait » longtemps.
 * Le VAD serveur rend la main dès la dernière syllabe et laisse le modèle
 * répondre pendant que l'utilisateur peut encore interrompre.
 */
const LIVE_TUNING = Object.freeze({
  silenceDurationMs: 500,
  prefixPaddingMs: 120,
  startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
  endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
  activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
});

const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,80}$/i;
const VOICE_RE = /^[A-Za-z]{2,32}$/;
// Le serveur peut refuser un champ de configuration récent : on réessaie une
// fois sans les réglages de tour avant de changer de modèle.
const SETUP_REJECT_RE = /invalid|unknown|unrecognized|unexpected|unsupported|not supported|invalid argument|invalide/i;
const MODEL_FALLBACK_RE = /not found|not_found|not supported|unsupported|inconnu|indisponible|404/i;

function normalizeModel(value) {
  const model = String(value || '').trim().replace(/^models\//i, '');
  return MODEL_RE.test(model) ? model : DEFAULT_MODEL;
}

function normalizeVoice(value) {
  const voice = String(value || '').trim();
  return VOICE_RE.test(voice) ? voice : DEFAULT_VOICE;
}

function closeReason(event) {
  let reason = String((event && event.reason) || '').trim();
  if (reason) {
    try {
      const parsed = JSON.parse(reason);
      reason = String(
        (parsed && parsed.error && parsed.error.message)
        || (parsed && parsed.message)
        || reason,
      );
    } catch (_error) {
      /* le serveur peut renvoyer un texte brut */
    }
  }
  if (!reason) {
    const code = event && Number.isFinite(event.code) ? event.code : 0;
    reason = code ? `Connexion fermée (code ${code}).` : 'Connexion Gemini Live fermée.';
  }
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function messageToText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (data && typeof data.text === 'function') return String(await data.text());
  return String(data || '');
}

function buildRealtimeInputConfig(tuning = LIVE_TUNING) {
  return {
    automaticActivityDetection: {
      disabled: false,
      startOfSpeechSensitivity: tuning.startOfSpeechSensitivity,
      endOfSpeechSensitivity: tuning.endOfSpeechSensitivity,
      prefixPaddingMs: tuning.prefixPaddingMs,
      silenceDurationMs: tuning.silenceDurationMs,
    },
    activityHandling: tuning.activityHandling,
  };
}

function buildSetup(session) {
  const setup = {
    model: `models/${session.model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: session.voice },
        },
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: {
      parts: [{ text: session.instruction || DEFAULT_INSTRUCTION }],
    },
    tools: [EMOTION_TOOL],
  };
  // `tuning === false` sert de repli si le serveur refuse la configuration.
  if (session.tuning !== false) {
    setup.realtimeInputConfig = buildRealtimeInputConfig(session.tuning || LIVE_TUNING);
  }
  return setup;
}

function extractToolCall(message) {
  const candidates = [];
  if (message && message.toolCall) candidates.push(message.toolCall);
  if (message && message.functionCall) candidates.push(message.functionCall);
  if (message && message.serverContent) {
    const serverContent = message.serverContent;
    const callArray = Array.isArray(serverContent.toolCall) ? serverContent.toolCall : [serverContent.toolCall];
    for (const call of callArray) if (call) candidates.push(call);
    const parts = Array.isArray(serverContent.modelTurn?.parts) ? serverContent.modelTurn.parts : [];
    for (const part of parts) {
      if (part && (part.functionCall || part.toolCall)) {
        candidates.push(part.functionCall || part.toolCall);
      }
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const resolved = candidate.functionCall || candidate;
    const name = String((candidate.name || resolved.name || resolved.functionName || '') || '').trim();
    const callArgs = candidate.args || resolved.args || candidate.arguments || resolved.arguments || candidate.parameters || resolved.parameters || {};
    if (!name) continue;
    return {
      id: String(candidate.id || resolved.id || `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      name,
      args: callArgs && typeof callArgs === 'object' ? callArgs : {},
    };
  }
  return null;
}

function mergeTranscription(current, next) {
  const text = String(next || '').trim();
  if (!text || text === current || current.endsWith(text)) return current;
  if (!current) return text;
  if (text.startsWith(current)) return text;
  return `${current}${/^[.,!?;:\-]/.test(text) ? '' : ' '}${text}`;
}

class LiveManager {
  constructor(options = {}) {
    this.WebSocketImpl = options.WebSocket || globalThis.WebSocket;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.connectTimeout = Number(options.connectTimeout) || 15000;
    this.maxReconnects = Number.isFinite(options.maxReconnects) ? options.maxReconnects : 4;
    this.sessions = new Map();
    this.counter = 0;
  }

  /**
   * Ouvre une session et attend `setupComplete`.
   * @returns {Promise<{ok:boolean, sessionId?:string, model?:string, voice?:string, error?:string}>}
   */
  async start(config = {}) {
    const key = String(config.key || '').trim();
    if (!key) return { ok: false, error: 'Clé Gemini manquante.' };
    if (!this.WebSocketImpl) {
      return { ok: false, error: 'WebSocket indisponible dans ce processus Electron.' };
    }
    if (config.owner != null) this.stopOwner(config.owner);

    const id = `live-${Date.now().toString(36)}-${++this.counter}`;
    const session = {
      id,
      key,
      owner: config.owner != null ? config.owner : null,
      model: normalizeModel(config.model),
      voice: normalizeVoice(config.voice),
      instruction: String(config.instruction || DEFAULT_INSTRUCTION).slice(0, 8000),
      emit: (event) => {
        try {
          if (typeof config.emit === 'function') {
            config.emit({ ...event, sessionId: id });
          }
        } catch (_error) {
          /* la fenêtre peut avoir disparu */
        }
      },
      ws: null,
      ready: false,
      everReady: false,
      stopped: false,
      reconnecting: false,
      reconnectTimer: null,
      goAwayTimer: null,
      attempts: 0,
      handle: '',
      pendingInputTranscription: '',
      tuning: true,
      _finishConnect: null,
    };

    const models = [session.model, DEFAULT_MODEL, ...FALLBACK_MODELS].filter(
      (model, index, list) => list.indexOf(model) === index,
    );
    let lastError = null;
    models: for (const model of models) {
      session.model = model;
      // Deux essais au plus par modèle : avec les réglages de tour, puis sans
      // eux si le serveur les refuse (API plus ancienne, modèle différent).
      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.sessions.set(id, session);
        try {
          await this._connect(session);
          return { ok: true, sessionId: id, model: session.model, voice: session.voice };
        } catch (error) {
          lastError = error;
          this.sessions.delete(id);
          session.ready = false;
          if (session.stopped) break models;
          const message = String((error && error.message) || '');
          if (attempt === 0 && session.tuning && SETUP_REJECT_RE.test(message)) {
            session.tuning = false;
            continue;
          }
          // Une clé invalide ou un quota épuisé ne se règle pas en changeant de
          // modèle : on ne réessaie que pour un modèle inconnu/indisponible.
          if (!MODEL_FALLBACK_RE.test(message)) break models;
          break;
        }
      }
    }
    return {
      ok: false,
      error: (lastError && lastError.message) || 'Connexion Gemini Live impossible.',
    };
  }

  _connect(session) {
    return new Promise((resolve, reject) => {
      if (session.stopped) {
        reject(new Error('Session arrêtée.'));
        return;
      }
      let settled = false;
      let ws = null;
      let errorTimer = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (errorTimer) clearTimeout(errorTimer);
        session._finishConnect = null;
        if (error) {
          reject(error);
          // Une erreur peut précéder la fermeture du socket : on le ferme pour
          // ne pas laisser une connexion orpheline qui consommerait du quota.
          try { if (ws && ws.readyState !== 3) ws.close(); } catch (_error) { /* ignore */ }
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => {
        finish(new Error('Délai de connexion Gemini Live dépassé.'));
        try { if (ws) ws.close(); } catch (_error) { /* ignore */ }
      }, this.connectTimeout);
      session._finishConnect = finish;

      const url = `${ENDPOINT}?key=${encodeURIComponent(session.key)}`;
      try {
        ws = new this.WebSocketImpl(url);
      } catch (error) {
        finish(error);
        return;
      }
      session.ws = ws;
      session.ready = false;
      try { ws.binaryType = 'arraybuffer'; } catch (_error) { /* ignore */ }

      ws.onopen = () => {
        if (session.ws !== ws) return;
        try {
          ws.send(JSON.stringify({ setup: buildSetup(session) }));
          this.log(`session ${session.id} ouverte (${session.model})`);
        } catch (error) {
          finish(error);
        }
      };

      ws.onmessage = (event) => {
        if (session.ws !== ws) return;
        this._handle(session, event).catch((error) => {
          this.log(`message ignoré : ${error && error.message ? error.message : error}`);
        });
      };

      ws.onerror = () => {
        if (session.ws !== ws) return;
        if (settled || session.ready) return;
        // Laisse une chance à `close` d'arriver avec le message détaillé du
        // serveur ; sinon on échoue après un court délai.
        if (!errorTimer) {
          errorTimer = setTimeout(() => {
            finish(new Error('Connexion Gemini Live refusée (clé, quota ou réseau).'));
          }, 300);
        }
      };

      ws.onclose = (event) => {
        clearTimeout(timer);
        if (errorTimer) clearTimeout(errorTimer);
        if (session.ws !== ws) return;
        if (!settled) {
          finish(new Error(closeReason(event)));
          return;
        }
        session.ready = false;
        if (session.stopped || session.reconnecting) return;
        // Échec de la connexion initiale : `start()` va rejeter (et tenter le
        // modèle de secours). On ne lance pas une reconnexion en parallèle.
        if (!session.everReady) return;
        this._scheduleReconnect(session, closeReason(event));
      };
    });
  }

  async _handle(session, event) {
    if (session.stopped || !this.sessions.has(session.id)) return;
    const text = await messageToText(event && event.data);
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (_error) {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.setupComplete) {
      const resumed = session.everReady;
      session.ready = true;
      session.attempts = 0;
      session.everReady = true;
      session.emit({
        type: resumed ? 'reconnected' : 'ready',
        model: session.model,
        voice: session.voice,
      });
      if (session._finishConnect) {
        const finish = session._finishConnect;
        session._finishConnect = null;
        finish(null);
      }
      return;
    }

    const content = message.serverContent;
    if (content && typeof content.inputTranscription?.text === 'string') {
      session.pendingInputTranscription = mergeTranscription(
        session.pendingInputTranscription,
        content.inputTranscription.text,
      );
    }
    const flushInputTranscription = () => {
      const inputText = session.pendingInputTranscription.trim();
      session.pendingInputTranscription = '';
      if (inputText) session.emit({ type: 'input-text', text: inputText, finished: true });
    };

    const toolRequest = extractToolCall(message);
    if (toolRequest) {
      flushInputTranscription();
      const requestedEmotion = String((toolRequest.args && toolRequest.args.emotion) || toolRequest.name || 'unknown');
      this.log(`[Gemini] Emotion requested: ${requestedEmotion}`);
      this.log(`[Electron] Emotion command received: ${requestedEmotion}`);
      session.emit({
        type: 'tool-call',
        sessionId: session.id,
        toolCallId: toolRequest.id,
        name: toolRequest.name,
        args: toolRequest.args || {},
      });
      return;
    }

    if (message.serverContent) {
      if (content.interrupted) session.emit({ type: 'interrupted' });
      const parts = (content.modelTurn && content.modelTurn.parts) || [];
      for (const part of parts) {
        const inline = part && part.inlineData;
        if (inline && inline.data) {
          session.emit({
            type: 'audio',
            data: inline.data,
            mimeType: inline.mimeType || 'audio/pcm;rate=24000',
          });
        }
      }
      const outputTranscription = content.outputTranscription;
      if (outputTranscription && typeof outputTranscription.text === 'string') {
        session.emit({
          type: 'text',
          text: outputTranscription.text,
          finished: outputTranscription.finished === true,
        });
      }
      if (content.generationComplete) session.emit({ type: 'generation-complete' });
      if (content.turnComplete) {
        flushInputTranscription();
        session.emit({ type: 'turn-complete' });
      }
    }

    if (message.usageMetadata) {
      const usage = message.usageMetadata;
      session.emit({
        type: 'usage',
        total: Number(usage.totalTokenCount) || 0,
        prompt: Number(usage.promptTokenCount) || 0,
        response: Number(usage.responseTokenCount) || 0,
      });
    }

    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable && update.newHandle) session.handle = String(update.newHandle);
    }

    if (message.goAway) {
      const ms = message.goAway.timeLeft
        ? Number(message.goAway.timeLeft.seconds || 0) * 1000
        : 0;
      session.emit({ type: 'go-away', ms });
      // Laisse le tour en cours se terminer, puis reconnecte avant la coupure.
      // Une fermeture naturelle entre-temps déclenche déjà la reconnexion.
      if (session.goAwayTimer) clearTimeout(session.goAwayTimer);
      const delay = ms > 2000 ? Math.min(ms - 1500, 8000) : 0;
      if (delay > 0) {
        session.goAwayTimer = setTimeout(() => {
          session.goAwayTimer = null;
          if (!session.stopped && !session.reconnecting) {
            this._scheduleReconnect(session, 'Fin de connexion annoncée par Gemini.');
          }
        }, delay);
        if (session.goAwayTimer.unref) session.goAwayTimer.unref();
      } else {
        this._scheduleReconnect(session, 'Fin de connexion annoncée par Gemini.');
      }
    }

  }

  _scheduleReconnect(session, reason) {
    if (session.stopped || session.reconnecting) return;
    if (session.goAwayTimer) {
      clearTimeout(session.goAwayTimer);
      session.goAwayTimer = null;
    }
    // Une clé invalide, un quota épuisé ou un projet sans accès (facturation)
    // ne se règle pas en réessayant : on ferme proprement pour ne pas
    // multiplier les connexions.
    if (/quota exceeded|resource.?exhausted|rate.?limit|429|permission.?denied|unauthenticated|api key (?:not valid|invalid|expired)|free tier|billing|paid tier|not available for this project/i.test(String(reason || ''))) {
      session.emit({ type: 'closed', error: reason || 'Session Gemini Live refusée.' });
      this._dispose(session);
      return;
    }
    if (session.attempts >= this.maxReconnects) {
      session.emit({ type: 'closed', error: reason || 'Session Gemini Live interrompue.' });
      this._dispose(session);
      return;
    }
    session.reconnecting = true;
    session.ready = false;
    session.attempts += 1;
    session.emit({ type: 'reconnecting', attempt: session.attempts });
    try { if (session.ws) session.ws.close(1000, 'reconnect'); } catch (_error) { /* ignore */ }
    const delay = Math.min(3000, 350 * session.attempts);
    session.reconnectTimer = setTimeout(async () => {
      session.reconnectTimer = null;
      if (session.stopped) return;
      try {
        await this._connect(session);
        session.reconnecting = false;
      } catch (error) {
        session.reconnecting = false;
        // Un handle de reprise expiré ne doit pas bloquer toutes les tentatives :
        // on repart sur une nouvelle session après l'avoir oublié.
        if (/handle|resumption|expired|invalid/i.test(String((error && error.message) || ''))) {
          session.handle = '';
        }
        if (!session.stopped) this._scheduleReconnect(session, (error && error.message) || reason);
      }
    }, delay);
    if (session.reconnectTimer.unref) session.reconnectTimer.unref();
  }

  _dispose(session) {
    session.stopped = true;
    session.ready = false;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
    if (session.goAwayTimer) clearTimeout(session.goAwayTimer);
    session.goAwayTimer = null;
    try { if (session.ws) session.ws.close(1000, 'dispose'); } catch (_error) { /* ignore */ }
    this.sessions.delete(session.id);
  }

  sendAudio(sessionId, data, mimeType) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ready || !session.ws) return false;
    if (typeof data !== 'string' || !data || data.length > 2 * 1024 * 1024) return false;
    try {
      session.ws.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data,
            mimeType: String(mimeType || 'audio/pcm;rate=16000'),
          },
        },
      }));
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Signale la fin du flux micro (micro coupé, pas fin de tour).
   * La fin de tour est désormais décidée par le VAD serveur configuré dans
   * `buildSetup` ; la page n'appelle plus cette méthode pendant une conversation.
   */
  sendAudioEnd(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ready || !session.ws) return false;
    try {
      session.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      return true;
    } catch (_error) {
      return false;
    }
  }

  /** Entrée texte ponctuelle (le mode vocal reste audio → audio). */
  sendText(sessionId, text) {
    const session = this.sessions.get(sessionId);
    const value = String(text || '').trim().slice(0, 3000);
    if (!session || !session.ready || !session.ws || !value) return false;
    try {
      session.ws.send(JSON.stringify({ realtimeInput: { text: value } }));
      return true;
    } catch (_error) {
      return false;
    }
  }

  sendToolResponse(sessionId, toolCallId, name, response) {
    const session = this.sessions.get(sessionId);
    const id = String(toolCallId || '').trim();
    const functionName = String(name || '').trim();
    if (!session || !session.ready || !session.ws || !id || !functionName) return false;
    try {
      session.ws.send(JSON.stringify({
        toolResponse: {
          functionResponses: [{
            id,
            name: functionName,
            response: response && typeof response === 'object' ? response : { ok: true },
          }],
        },
      }));
      return true;
    } catch (_error) {
      return false;
    }
  }

  stop(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this._dispose(session);
    return true;
  }

  stopOwner(owner) {
    for (const session of [...this.sessions.values()]) {
      if (session.owner === owner) this._dispose(session);
    }
  }

  closeAll() {
    for (const session of [...this.sessions.values()]) this._dispose(session);
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = {
  LiveManager,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  FALLBACK_MODELS,
  DEFAULT_INSTRUCTION,
  LIVE_TUNING,
  buildSetup,
  buildRealtimeInputConfig,
  normalizeModel,
  normalizeVoice,
  closeReason,
};
