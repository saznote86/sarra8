import { readWorkshopProfile } from '../audio/profile.js';
import { openAmbientMicrophone, queueLocalSpeech } from '../audio/browser.js';
import {
  createMouthState,
  microphoneTargets,
  mixSpeechTargets,
  advanceMouth,
  addVisemeMorphs,
  addMouthAccents,
} from '../audio/lipsync.js';

// A UI adapter, not a second audio engine. Sample the original audio pipeline
// from the existing render loop; only the visible avatar receives its weights.
export function mountAudioPanel({ getAvatar, onMouthMode }) {
  const $ = (id) => document.getElementById(id);
  let storage;
  try {
    storage = window.localStorage;
  } catch {
    /* private/embedded context */
  }
  const cfg = readWorkshopProfile(storage);
  const synth = window.speechSynthesis;
  const canSpeak = !!(synth && window.SpeechSynthesisUtterance);
  const canListen = !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));
  const field = $('audio-controls'),
    picker = $('audio-voice'),
    micButton = $('audio-mic'),
    meter = $('audio-level');
  const micEnv = { g: 1 };
  let enabled = false,
    voices = [],
    chosenVoice = null,
    speech = null,
    mic = null,
    pendingMic = null;
  let mouth = createMouthState(),
    jawRest = null,
    releasing = 0,
    ownsMouth = false;

  function note(text, error = false) {
    $('audio-state').textContent = text;
    $('audio-state').dataset.error = String(error);
    $('audio-open').hidden = !error || window.self === window.top;
  }
  function refreshVoices() {
    const previous = chosenVoice;
    voices = synth?.getVoices() || [];
    picker.replaceChildren();
    if (!voices.length) picker.add(new Option('Voix par défaut', ''));
    voices.forEach((voice, i) => picker.add(new Option(`${voice.name} (${voice.lang})`, String(i))));
    let index = previous
      ? voices.findIndex(
          (v) => v.name === previous.name && v.lang === previous.lang && v.voiceURI === previous.voiceURI,
        )
      : -1;
    if (index < 0) index = voices.findIndex((v) => /^fr/i.test(v.lang));
    if (index >= 0) picker.value = String(index);
  }
  function clearLayer() {
    const avatar = getAvatar();
    avatar?.core.setVisemeContributions({});
    avatar?.core.setSpeechAmount(0);
    avatar?.core.setJawOpen(Number($('jaw').value));
    if (jawRest?.node) {
      jawRest.node.rotation.x = jawRest.x;
      jawRest.node.rotation.y = jawRest.y;
    }
    jawRest = null;
    mouth = createMouthState();
    meter.value = 0;
  }
  function refresh() {
    field.disabled = !enabled;
    $('audio-say').disabled = !canSpeak || !!speech || !$('audio-text').value.trim();
    $('audio-stop').disabled = !speech;
    picker.disabled = !canSpeak || !!speech;
    micButton.disabled = !canListen;
    micButton.setAttribute('aria-pressed', String(!!mic));
    micButton.setAttribute('aria-busy', String(!!pendingMic));
    $('audio-mic-label').textContent = mic
      ? 'Couper le micro'
      : pendingMic
        ? 'Annuler la demande'
        : 'Activer le micro';
    const busy = !!(mic || speech || releasing > 0);
    if (busy !== ownsMouth) {
      ownsMouth = busy;
      if (!busy) clearLayer();
      onMouthMode(busy);
    }
  }
  function stopSpeech() {
    if (!speech) return;
    const previous = speech;
    speech = null;
    clearTimeout(previous.timer);
    synth.cancel(); // callbacks from this cancelled utterance cannot affect a later one
  }
  function stopMic() {
    const request = pendingMic;
    pendingMic = null;
    request?.abort();
    const device = mic;
    mic = null;
    device?.close();
    micEnv.g = 1;
  }
  function stopAll(message = 'Audio arrêté.') {
    const wasActive = !!(pendingMic || mic || speech || releasing);
    stopSpeech();
    stopMic();
    releasing = 0;
    refresh();
    if (wasActive) note(message);
  }
  function say() {
    const text = $('audio-text').value.trim();
    if (!enabled || !canSpeak || !text || speech) return;
    const ticket = { timeline: null, started: false, timer: null, utterance: null };
    speech = ticket;
    releasing = 0;
    note('Démarrage de la voix…');
    refresh();
    try {
      ticket.utterance = queueLocalSpeech(text, cfg, {
        voice: voices[Number(picker.value)],
        onTimeline: (timeline) => {
          ticket.timeline = timeline;
        },
        onStart: () => {
          if (speech !== ticket) return;
          clearTimeout(ticket.timer);
          ticket.started = true;
          note('Sarra parle.');
        },
        onFinish: (error) => {
          if (speech !== ticket) return;
          clearTimeout(ticket.timer);
          speech = null;
          // Let the original closure / jaw lag finish a naturally ended phrase.
          if (!error && !mic && ticket.started) releasing = (cfg.hold + 5 * Math.max(cfg.clo, cfg.jawLag)) / 1000;
          note(
            error
              ? 'La voix n’a pas pu lire le texte. Essayez une autre voix ou vérifiez les voix installées.'
              : mic
                ? 'Lecture terminée · micro actif.'
                : 'Lecture terminée.',
            !!error,
          );
          refresh();
        },
      });
      // Some embedded browsers expose Web Speech but never start an utterance.
      if (speech === ticket && !ticket.started)
        ticket.timer = setTimeout(() => {
          if (speech !== ticket || ticket.started) return;
          stopSpeech();
          refresh();
          note(
            'Aucune voix n’a démarré. Vérifiez les voix du système ou ouvrez l’atelier dans votre navigateur.',
            true,
          );
        }, 10000);
    } catch (error) {
      stopSpeech();
      refresh();
      note(error.message, true);
    }
  }
  async function toggleMic() {
    if (!enabled || !canListen) return;
    if (mic || pendingMic) {
      stopMic();
      refresh();
      note(speech ? 'Micro coupé · lecture en cours.' : 'Micro coupé.');
      return;
    }
    const request = new AbortController();
    pendingMic = request;
    note('Autorisez le micro dans le navigateur.');
    refresh();
    try {
      const device = await openAmbientMicrophone({ signal: request.signal });
      if (request !== pendingMic) {
        device.close();
        return;
      }
      pendingMic = null;
      mic = device;
      releasing = 0;
      for (const track of device.stream.getAudioTracks())
        track.addEventListener(
          'ended',
          () => {
            if (mic !== device) return;
            stopMic();
            refresh();
            note('Micro déconnecté.');
          },
          { once: true },
        );
      note('Micro actif · parlez pour animer les lèvres.');
    } catch (error) {
      if (request !== pendingMic) return;
      pendingMic = null;
      note(
        error.name === 'NotAllowedError'
          ? 'Accès au micro refusé ou bloqué par l’aperçu. Autorisez-le dans le navigateur.'
          : `Micro indisponible : ${error.message}`,
        true,
      );
    } finally {
      refresh();
    }
  }
  function applyFrame(dt, now) {
    const avatar = getAvatar();
    if (!avatar || !(mic || speech?.started || releasing > 0)) return;
    mouth.closing = false;
    const targets = mic ? [...microphoneTargets(mic, cfg, micEnv), 0, 0] : [0, 0, 0, 0, 0, 0, 0];
    if (speech?.started) speech.timeline = mixSpeechTargets(targets, mouth, speech.timeline, cfg, dt, now);
    advanceMouth(mouth, targets, cfg, dt, now);
    const weights = {};
    const add = (name, weight) => {
      if (weight && avatar.targets.has(name)) weights[name] = (weights[name] || 0) + weight;
    };
    addVisemeMorphs(mouth, cfg, add);
    addMouthAccents(mouth, cfg, now, add);
    const amount = Math.max(mouth.jo, ...mouth.s);
    avatar.core.setVisemeContributions(weights);
    avatar.core.setSpeechAmount(amount);
    avatar.core.setJawOpen(mouth.jo * cfg.jawMorph);
    if (!jawRest) {
      const node = avatar.vrm.humanoid?.getNormalizedBoneNode?.('jaw');
      jawRest = node ? { node, x: node.rotation.x, y: node.rotation.y } : { node: null };
    }
    if (jawRest.node) {
      jawRest.node.rotation.x = (mouth.jo * cfg.jawMax * Math.PI) / 180;
      jawRest.node.rotation.y = Math.sin(now * 0.004) * cfg.jawSway * mouth.jo * 0.15;
    }
    const level = Math.round(Math.min(1, amount) * 100);
    if (meter.value !== level) meter.value = level;
    if (releasing > 0) {
      releasing = Math.max(0, releasing - dt);
      if (!releasing) refresh();
    }
  }

  picker.onchange = () => {
    chosenVoice = voices[Number(picker.value)] || null;
  };
  refreshVoices();
  synth?.addEventListener?.('voiceschanged', refreshVoices);
  $('audio-open').href = window.location.href;
  $('audio-text').oninput = refresh;
  $('audio-form').onsubmit = (event) => {
    event.preventDefault();
    say();
  };
  $('audio-stop').onclick = () => {
    stopSpeech();
    releasing = 0;
    refresh();
    note(mic ? 'Lecture arrêtée · micro actif.' : 'Lecture arrêtée.');
  };
  micButton.onclick = toggleMic;
  if (!canSpeak || !canListen)
    note(
      [
        !canSpeak && 'Synthèse vocale indisponible dans ce navigateur.',
        !canListen && 'Micro indisponible : vérifiez HTTPS et les autorisations.',
      ]
        .filter(Boolean)
        .join(' '),
      true,
    );
  refresh();
  return {
    get ownsMouth() {
      return ownsMouth;
    },
    applyFrame,
    stopAll,
    enable(value) {
      enabled = value;
      if (!enabled) stopAll();
      else refresh();
    },
    dispose() {
      stopAll();
      synth?.removeEventListener?.('voiceschanged', refreshVoices);
    },
  };
}
