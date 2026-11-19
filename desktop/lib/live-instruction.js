'use strict';

/**
 * live-instruction.js
 * ---------------------------------------------------------------------------
 * Composition de l'instruction d'une session **Gemini Live**.
 *
 * L'app envoie déjà son instruction (`liveInstruction()`), construite à partir
 * de ses propres directives `localStorage`. Ici on y ajoute, sans doublon :
 *
 *   1. l'identité de `state.json` (avatarName / userName) ;
 *   2. les **coreDirectives** persistées (tâche 4) ;
 *   3. un digest des **10 derniers échanges** de `chatHistory`, pour que la
 *      conversation directe garde la mémoire du chat texte.
 *
 * `desktop/live.js` tronque l'instruction à 8000 caractères : on reste sous
 * cette limite, en coupant le digest avant les directives.
 * ---------------------------------------------------------------------------
 */

const MAX_INSTRUCTION_CHARS = 7600;
const DEFAULT_MEMORY_EXCHANGES = 10;
const MAX_MESSAGE_CHARS = 180;
const MAX_DIGEST_CHARS = 2200;

const clean = (value, max = 8000) =>
  String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);

/** Les N derniers échanges, formatés pour une instruction système. */
function buildMemoryDigest(state = {}, exchanges = DEFAULT_MEMORY_EXCHANGES) {
  const history = Array.isArray(state.chatHistory) ? state.chatHistory : [];
  if (!history.length) return '';

  const limit = Math.max(1, Math.min(40, Number(exchanges) || DEFAULT_MEMORY_EXCHANGES));
  const slice = history.slice(-limit * 2);

  const lines = [];
  for (const message of slice) {
    const text = clean(message && message.text, 2000);
    if (!text) continue;
    const short = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
    lines.push(`${message.role === 'model' ? 'Sarra' : 'Utilisateur'} : ${short}`);
  }
  if (!lines.length) return '';

  const digest = lines.join('\n');
  return digest.length > MAX_DIGEST_CHARS
    ? `${digest.slice(0, MAX_DIGEST_CHARS)}…`
    : digest;
}

/**
 * @param {object} opts
 * @param {string} [opts.appInstruction] Instruction fournie par l'app (prioritaire)
 * @param {object} [opts.state]           État persistant (`state.json`)
 * @param {number} [opts.exchanges]       Nombre d'échanges à rappeler
 * @returns {string} instruction finale (≤ 7600 caractères)
 */
function composeLiveInstruction(opts = {}) {
  const state = opts.state || {};
  const appInstruction = clean(opts.appInstruction, MAX_INSTRUCTION_CHARS);
  const blocks = [];

  if (appInstruction) blocks.push(appInstruction);

  const avatarName = clean(state.avatarName, 80);
  const userName = clean(state.userName, 80);

  // Identité : uniquement si l'app ne la donne pas déjà.
  const identityLine =
    avatarName && userName
      ? `Tu es ${avatarName}, avatar de bureau de Sarra8, et tu parles à ${userName}.`
      : avatarName
        ? `Tu es ${avatarName}, avatar de bureau de Sarra8.`
        : '';
  if (identityLine && !/avatar du bureau|avatar de bureau/i.test(appInstruction)) {
    blocks.push(identityLine);
  }

  // Directives persistées (tâche 4) : évite la redondance avec l'app.
  const directives = clean(state.coreDirectives, 6000);
  const alreadyThere = directives && appInstruction.includes(directives.slice(0, 80));
  if (directives && !alreadyThere) {
    blocks.push(`Directives de base enregistrées dans l'application :\n"""\n${directives}\n"""`);
  }

  // Mémoire courte
  const digest = buildMemoryDigest(state, opts.exchanges || DEFAULT_MEMORY_EXCHANGES);
  if (digest) {
    blocks.push(
      [
        "Mémoire des derniers échanges écrits (rappelle-toi le contexte, ne le récite pas) :",
        '"""',
        digest,
        '"""'
      ].join('\n')
    );
  }

  if (blocks.length) {
    blocks.push(
      'Réponds à l’oral, en phrases courtes. Pour une demande explicite de sourire ou d’émotion faciale, appelle l’outil set_emotion au lieu de dire que tu ne peux pas.'
    );
  }

  let instruction = blocks.join('\n\n');
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    instruction = `${instruction.slice(0, MAX_INSTRUCTION_CHARS - 1)}…`;
  }
  return instruction;
}

module.exports = {
  MAX_INSTRUCTION_CHARS,
  DEFAULT_MEMORY_EXCHANGES,
  buildMemoryDigest,
  composeLiveInstruction
};
