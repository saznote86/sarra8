'use strict';

/**
 * tts-bridge.js — pont vers l'hôte vocal Python/Qt existant
 * ---------------------------------------------------------------------------
 * L'hôte `desktop/tts/tts_host.py` (PyQt6 + QTextToSpeech) écoute sur
 * 127.0.0.1:8649 et parle en **JSON par ligne**. C'est le contrat historique du
 * dépôt (voir desktop/README.md § Voix), il n'est pas modifié ici.
 *
 * Sens client -> hôte
 *   {"type":"hello","client":"sarra-electron","protocol":1}
 *   {"type":"voices"}
 *   {"type":"speak","id":12,"text":"…","voice":"Hortense","lang":"fr-FR","rate":1,"volume":1}
 *   {"type":"stop"}
 *
 * Sens hôte -> client (types reconnus, avec ou sans enveloppe {"event":…})
 *   {"type":"ready"}
 *   {"type":"voices","voices":[{"name":"Hortense","lang":"fr-FR","default":true}]}
 *   {"type":"start","id":12}
 *   {"type":"boundary","id":12,"charIndex":0,"charLength":5,"word":"Bonjour","elapsedTime":120}
 *   {"type":"end","id":12}
 *   {"type":"error","id":12,"message":"…"}
 *
 * Ces événements sont relayés au renderer, qui remplace `speechSynthesis` par un
 * proxy (`onstart` / `onboundary` / `onend` / `onerror`) : c'est le mécanisme de
 * recalage du lipsync sur les repères de mots, à préserver tel quel.
 *
 * Si aucun hôte n'écoute, le pont tente de le lancer (réplique du repli décrit
 * dans le README) puis, en dernier recours, signale « mode silencieux » : la
 * fenêtre avatar reste utilisable.
 * ---------------------------------------------------------------------------
 */

const net = require('net');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8649;

class TtsHostBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host || DEFAULT_HOST;
    this.port = Number(opts.port) || DEFAULT_PORT;
    this.logger = opts.logger || console;

    this.socket = null;
    this.child = null;
    this.buffer = '';

    this.status = 'idle'; // idle | connecting | ready | starting | unavailable | stopped
    this.lastError = null;
    this.voices = Array.isArray(opts.voices) ? opts.voices.slice() : [];

    this.spawnEnabled = opts.spawnEnabled !== false;
    this.pythonPath = opts.pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
    this.scriptPath = opts.scriptPath || null;
    this.logPath = opts.logPath || null;

    this._attempts = 0;
    this._maxAttempts = Number(opts.maxAttempts) || 3;
    this._closed = false;
    this._retryTimer = null;
  }

  get available() {
    return this.status === 'ready' && !!this.socket && !this.socket.destroyed;
  }

  getStatus() {
    return {
      status: this.status,
      available: this.available,
      host: this.host,
      port: this.port,
      voices: this.voices.slice(),
      lastError: this.lastError
    };
  }

  /* ---------------------------------------------------------------- */
  /* Cycle de vie                                                      */
  /* ---------------------------------------------------------------- */

  start() {
    this._closed = false;
    return this._tryConnect();
  }

  _tryConnect() {
    if (this._closed) return Promise.resolve(false);
    this.status = 'connecting';
    this.emit('status', this.getStatus());

    return new Promise((resolve) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.lastError = err && err.message ? err.message : String(err);
        try {
          socket.destroy();
        } catch (_) {
          /* ignore */
        }
        this._onConnectFailed(resolve);
      };

      socket.setEncoding('utf8');
      socket.setNoDelay(true);
      socket.setTimeout(2500, () => fail(new Error('timeout de connexion')));

      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        socket.setTimeout(0);
        this._attach(socket);
        resolve(true);
      });

      socket.once('error', fail);
    });
  }

  async _onConnectFailed(resolve) {
    this._attempts += 1;

    // Repli 1 : lancer l'hôte nous-mêmes (comme décrit dans le README)
    if (this.spawnEnabled && this._attempts === 1 && this._hostScriptExists()) {
      this.status = 'starting';
      this.emit('status', this.getStatus());
      this._spawnHost();
      // Laisser à Python le temps d'ouvrir le port, puis réessayer.
      await new Promise((r) => setTimeout(r, 1200));
      this._attempts = 0; // la tentative de reconnexion ne consomme pas le quota
      this._closed = false;
      try {
        const ok = await this._tryConnect();
        if (ok) return resolve(true);
      } catch (_) {
        /* ignore */
      }
    }

    if (this._attempts < this._maxAttempts) {
      this._retryTimer = setTimeout(() => {
        this._closed = false;
        const savedAttempts = this._attempts;
        this._tryConnect().then((ok) => {
          if (!ok) this._attempts = savedAttempts;
        });
      }, 700 * this._attempts);
      if (this._retryTimer.unref) this._retryTimer.unref();
      return resolve(false);
    }

    this.status = 'unavailable';
    this.lastError =
      this.lastError ||
      `Aucun hôte vocal sur ${this.host}:${this.port} (Python/PyQt6 absent ?). L'avatar reste utilisable en mode silencieux.`;
    this.emit('status', this.getStatus());
    this.logger.warn(`[tts] ${this.lastError}`);
    resolve(false);
  }

  _hostScriptExists() {
    if (!this.scriptPath) return false;
    try {
      return fs.existsSync(this.scriptPath);
    } catch (_) {
      return false;
    }
  }

  _spawnHost() {
    if (this.child) return;
    const args = [this.scriptPath, '--port', String(this.port)];
    if (this.logPath) args.push('--log', this.logPath);

    try {
      this.child = spawn(this.pythonPath, args, {
        cwd: path.dirname(this.scriptPath),
        windowsHide: true,
        detached: false,
        stdio: 'ignore'
      });
      this.child.on('error', (err) => {
        this.lastError = `Lancement de l'hôte vocal impossible : ${err.message}`;
        this.emit('status', this.getStatus());
      });
      this.child.on('exit', () => {
        this.child = null;
      });
    } catch (err) {
      this.lastError = err.message;
      this.emit('status', this.getStatus());
    }
  }

  _attach(socket) {
    this.socket = socket;
    this.buffer = '';
    this.status = 'ready';
    this.lastError = null;
    this._attempts = 0;

    socket.on('data', (chunk) => this._consume(chunk));
    socket.on('error', (err) => {
      this.lastError = err.message;
      this.emit('status', this.getStatus());
    });
    socket.on('close', () => {
      const wasReady = this.status === 'ready';
      this.socket = null;
      if (this._closed) {
        this.status = 'stopped';
        this.emit('status', this.getStatus());
        return;
      }
      this.status = 'unavailable';
      this.emit('status', this.getStatus());
      if (wasReady) {
        this.emit('disconnected', {});
        // Reconnexion silencieuse (l'hôte peut redémarrer indépendamment)
        this._retryTimer = setTimeout(() => {
          this._closed = false;
          this._attempts = 0;
          this._tryConnect();
        }, 2500);
        if (this._retryTimer.unref) this._retryTimer.unref();
      }
    });

    this.send({ type: 'hello', client: 'sarra-electron', protocol: 1 });
    this.send({ type: 'voices' });
    this.emit('status', this.getStatus());
  }

  _consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = '';
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed[0] !== '{') {
        this.emit('log', trimmed);
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (_) {
        this.emit('log', trimmed);
        continue;
      }
      this._handle(msg);
    }
  }

  _handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    const payload = msg.event && typeof msg.event === 'object' ? msg.event : msg;
    const type = String(payload.type || payload.event || '').toLowerCase();

    if (type === 'voices' || Array.isArray(payload.voices)) {
      if (Array.isArray(payload.voices)) {
        this.voices = payload.voices
          .filter((v) => v && typeof v === 'object')
          .map((v) => ({
            name: String(v.name || v.voice || ''),
            lang: v.lang || v.locale || 'fr-FR',
            default: v.default === true
          }))
          .filter((v) => v.name);
        this.emit('voices', this.voices);
        this.emit('status', this.getStatus());
      }
      return;
    }

    if (type === 'ready' || type === 'hello' || type === 'ready-ok') {
      if (this.status === 'ready') return; // pas de doublon à chaque handshake
      this.status = 'ready';
      this.emit('status', this.getStatus());
      return;
    }

    if (['start', 'boundary', 'end', 'error', 'speak', 'word'].includes(type)) {
      const event = {
        id: payload.id != null ? payload.id : null,
        type: type === 'word' ? 'boundary' : type,
        charIndex: Number.isFinite(Number(payload.charIndex)) ? Number(payload.charIndex) : 0,
        charLength: Number.isFinite(Number(payload.charLength)) ? Number(payload.charLength) : 0,
        word: payload.word != null ? String(payload.word) : '',
        elapsedTime: Number.isFinite(Number(payload.elapsedTime)) ? Number(payload.elapsedTime) : 0,
        message: payload.message || payload.error || ''
      };
      if (type === 'error') {
        this.lastError = event.message || 'erreur de synthèse';
        this.emit('status', this.getStatus());
      }
      this.emit('tts-event', event);
      return;
    }

    this.emit('log', `message inconnu : ${type}`);
  }

  /* ---------------------------------------------------------------- */
  /* Commandes                                                         */
  /* ---------------------------------------------------------------- */

  send(payload) {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch (err) {
      this.logger.warn(`[tts] écriture impossible : ${err.message}`);
      return false;
    }
  }

  speak({ id, text, voice, lang = 'fr-FR', rate = 1, volume = 1 } = {}) {
    const clean = String(text == null ? '' : text).trim();
    if (!clean) return false;
    return this.send({
      type: 'speak',
      id: id != null ? id : Date.now(),
      text: clean.slice(0, 8000),
      voice: voice || '',
      lang,
      rate,
      volume
    });
  }

  stop() {
    return this.send({ type: 'stop' });
  }

  requestVoices() {
    return this.send({ type: 'voices' });
  }

  dispose() {
    this._closed = true;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
    try {
      if (this.socket) {
        this.socket.end();
        this.socket.destroy();
      }
    } catch (_) {
      /* ignore */
    }
    this.socket = null;
    if (this.child) {
      try {
        this.child.kill();
      } catch (_) {
        /* ignore */
      }
      this.child = null;
    }
    this.status = 'stopped';
  }
}

module.exports = { TtsHostBridge, DEFAULT_HOST, DEFAULT_PORT };
