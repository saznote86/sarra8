import { createSpeechTimeline, syncSpeechBoundary } from './lipsync.js';

// Web Speech in a browser; the existing SAPI/Qt Web Speech bridge in Electron.
// No audio generation, relay, recording or provider credentials here.
export function queueLocalSpeech(text, cfg, { host = globalThis, voice, onTimeline, onStart, onFinish } = {}) {
  const synth = host.speechSynthesis;
  if (!synth || !host.SpeechSynthesisUtterance) throw new Error('Synthèse vocale indisponible.');
  synth.cancel();
  const timeline = createSpeechTimeline(text, cfg);
  const utterance = new host.SpeechSynthesisUtterance(text);
  utterance.lang = 'fr-FR';
  utterance.rate = cfg.rate;
  if (voice) utterance.voice = voice;
  const finish = (error) => {
    if (timeline.ended) return;
    timeline.ended = true;
    timeline.p = timeline.total;
    onFinish?.(error, timeline);
  };
  utterance.onstart = () => {
    if (timeline.ended) return;
    timeline.p = 0;
    timeline.startedAt = host.performance.now();
    onStart?.(timeline);
  };
  utterance.onboundary = (event) => {
    if (!timeline.ended)
      syncSpeechBoundary(timeline, Number(event.charIndex) || 0, event.elapsedTime, host.performance.now());
  };
  utterance.onend = () => finish(null);
  utterance.onerror = (event) => finish(event.error || 'synthesis-failed');
  onTimeline?.(timeline);
  try {
    synth.speak(utterance);
  } catch (error) {
    finish(error.message || 'synthesis-failed');
  }
  return utterance;
}

// Same ambient microphone graph as the original app: source → analyser only.
// Never connect the microphone to the speakers. Closing also handles a grant
// that arrives after the user cancelled the browser's permission prompt.
export async function openAmbientMicrophone({ host = globalThis, signal } = {}) {
  const Context = host.AudioContext || host.webkitAudioContext;
  if (!Context || !host.navigator?.mediaDevices?.getUserMedia) {
    throw new Error('Micro indisponible. Utilisez HTTPS ou localhost dans un navigateur compatible.');
  }
  signal?.throwIfAborted();
  const stream = await host.navigator.mediaDevices.getUserMedia({ audio: true });
  let ctx,
    source,
    an,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    for (const track of stream.getTracks()) track.stop();
    source?.disconnect();
    an?.disconnect();
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
  };
  try {
    signal?.throwIfAborted();
    signal?.addEventListener('abort', close, { once: true });
    ctx = new Context();
    an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.5;
    source = ctx.createMediaStreamSource(stream);
    source.connect(an);
    if (ctx.state === 'suspended') await ctx.resume();
    signal?.throwIfAborted();
    return { stream, ctx, an, f: new Uint8Array(an.frequencyBinCount), w: new Uint8Array(an.fftSize), close };
  } catch (error) {
    close();
    throw error;
  }
}
