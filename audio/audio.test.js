import test from 'node:test';
import assert from 'node:assert/strict';
import { CALIBRATED_DEFAULTS as cfg, readWorkshopProfile } from './profile.js';
import {
  build,
  createSpeechTimeline,
  syncSpeechBoundary,
  mixSpeechTargets,
  createMouthState,
  advanceMouth,
  addVisemeMorphs,
  addMouthAccents,
  microphoneTargets,
  advanceVisemeCursor,
  sampleVisemeTargets,
} from './lipsync.js';
import { queueLocalSpeech, openAmbientMicrophone } from './browser.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('the shared factory phonemes, jaw and morphs reproduce samples from c352b58', () => {
  // Original browser app at 60 Hz, default settings, real-time clock starting at zero.
  let timeline = createSpeechTimeline('Papa fait un beau sourire.', cfg);
  near(timeline.total, 1.746031746031746);
  timeline.startedAt = 0;
  const state = createMouthState();
  const reference = new Map([
    [5, [0.043627386567832986, 0.045555471769092686, 0.0020132764246395423]],
    [23, [0.10840922772607797, 0.11135888317098597, 0.000272923160057802]],
    [62, [0.06609515454078481, 0, 0.0017640765566929997]],
  ]);
  for (let frame = 0; frame <= 62; frame++) {
    const now = frame * (1000 / 60),
      targets = Array(7).fill(0);
    state.closing = false;
    timeline = mixSpeechTargets(targets, state, timeline, cfg, 1 / 60, now);
    advanceMouth(state, targets, cfg, 1 / 60, now);
    const weights = {},
      add = (name, value) => {
        weights[name] = (weights[name] || 0) + value;
      };
    addVisemeMorphs(state, cfg, add);
    addMouthAccents(state, cfg, now, add);
    if (reference.has(frame))
      [state.jo, weights.aa || 0, weights.PP || 0].forEach((v, i) => near(v, reference.get(frame)[i]));
  }
});

test('les graphèmes français produisent des visèmes et des durées plausibles', () => {
  const photo = build('photo');
  assert.equal(photo[0].f, 1);
  assert.equal(photo[0].d, 0.28);
  assert.equal(photo[0].end, 2);

  const chat = build('chat');
  assert.equal(chat[0].v, -1);
  assert.equal(chat[0].d, 0.22);
  assert.equal(chat[0].end, 2);

  const montagne = build('montagne');
  const gn = montagne.find((entry) => entry.pos === 5);
  assert.equal(gn.d, 0.22);
  assert.equal(gn.end, 7);

  const quatre = build('quatre');
  assert.equal(quatre[0].d, 0.18);
  assert.equal(quatre[0].end, 2);

  const guerre = build('guerre');
  assert.equal(guerre[0].d, 0.18);
  assert.equal(guerre[0].end, 2);

  const whisky = build('whisky');
  assert.equal(whisky[0].v, 4);
  assert.equal(whisky[0].end, 2);

  const thé = build('thé');
  assert.equal(thé[0].d, 0.2);
  assert.equal(thé[0].end, 2);

  const coeur = build('cœur');
  assert.equal(coeur.find((entry) => entry.v === 1).pos, 1);
});

test('le curseur de visèmes respecte la durée relative de chaque phonème', () => {
  const seq = [{ d: 0.5 }, { d: 2 }, { d: 1 }];
  near(advanceVisemeCursor(seq, 0, 0.25, 1, 1), 0.5);
  near(advanceVisemeCursor(seq, 0, 0.5, 1, 1), 1);
  near(advanceVisemeCursor(seq, 1, 1, 1, 1), 1.5);
  near(advanceVisemeCursor(seq, 1.5, 10, 1, 1), 3 - 0.000001);
  assert.equal(advanceVisemeCursor([], 0, 1, 14, 1), 0);
  assert.equal(advanceVisemeCursor(null, 0, 1, 14, 1), 0);
});

test('sampleVisemeTargets anticipe le phonème suivant et garde la bouche tenue', () => {
  const seq = [
    { v: 0, d: 1 },
    { v: 2, d: 1 },
  ];
  assert.deepEqual(sampleVisemeTargets(seq, 0.1, { coart: 0 }), [1, 0, 0, 0, 0, 0, 0]);
  const late = sampleVisemeTargets(seq, 0.95, { coart: 1 });
  assert.ok(late[0] < 0.6 && late[0] > 0);
  assert.ok(late[2] > 0.4);
  assert.equal(sampleVisemeTargets([], 0, {}), null);
  const gap = sampleVisemeTargets([{ v: 0, d: 1 }, { v: -1, d: 1 }], 1.5, {});
  assert.equal(gap[0], 1);
});

test('l’anticipation prépare la consonne suivante sans modifier le profil historique', () => {
  const seq = [
    { v: 0, w: 1, d: 1, cl: 0, f: 0, start: 0, end: 1 },
    { v: -1, w: 0, d: 0.48, cl: 1, f: 0, start: 1, end: 1.48 },
  ];
  const at = (extra) => {
    const targets = Array(7).fill(0);
    const tts = { seq, total: 1.48, i: 0, startedAt: 0, p: 0, ended: false };
    mixSpeechTargets(targets, createMouthState(), tts, { ...cfg, ...extra }, 1 / 60, 890);
    return targets;
  };
  const natural = at({ antic: 60, consonantLead: 80, coart: 1 });
  const legacy = at({});
  assert.ok(natural[0] < 1 && natural[0] > 0);
  assert.ok(natural[5] > 0.05);
  assert.equal(legacy[0], 1);
  assert.equal(legacy[5], 0);
});

test('word marks and the playback clock position labial F inside the right word', () => {
  const marks = [
    { text: 'papa', start: 0.1, duration: 0.4 },
    { text: 'fait', start: 0.6, duration: 0.3 },
  ];
  const tl = createSpeechTimeline('Papa fait', cfg, marks, 1);
  assert.ok(tl.aligned);
  tl.audioDriven = true;
  const targets = Array(7).fill(0),
    state = createMouthState();
  mixSpeechTargets(targets, state, tl, cfg, 0.016, 2500, 0.605);
  near(tl.p, 0.605);
  assert.ok(targets[6] > 0.3);
  assert.equal(targets[5], 0);
  tl.audioDriven = false;
  tl.startedAt = 1000;
  assert.ok(syncSpeechBoundary(tl, 5, 0.725, 1800));
  near(tl.boundaryAt, 1725);
  near(tl.boundaryPlayhead, 0.6);
  assert.equal(syncSpeechBoundary(tl, 1000, 3, 4000), false);
  tl.ended = true;
  assert.equal(mixSpeechTargets(targets, state, tl, cfg, 0.016, 4000), null);
});

test('the workshop reads existing lipdef/lipcfg without migration, writes or access to keys', () => {
  const read = [];
  const s = {
    getItem(key) {
      read.push(key);
      return JSON.stringify(key === 'lipdef' ? { rate: 0.8, sens: 4 } : { rate: 1.1, map: { P: { PP: 0.2 } } });
    },
  };
  const profile = readWorkshopProfile(s);
  assert.deepEqual(read, ['lipdef', 'lipcfg']);
  assert.equal(profile.rate, 1.1);
  assert.equal(profile.sens, 4);
  assert.deepEqual(profile.map.P, { PP: 0.2 });
  assert.deepEqual(profile.map.F, cfg.map.F);
  assert.deepEqual(readWorkshopProfile({ getItem: () => '{' }), cfg);
  assert.notEqual(profile.map, cfg.map);
});

test('Web Speech gets the user voice, original rate and exact text, and owns its distinct timeline', () => {
  let now = 100,
    cancel = 0,
    dispatched,
    timeline,
    end = 0;
  const host = {
    performance: { now: () => now },
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    speechSynthesis: {
      cancel() {
        cancel++;
      },
      speak(u) {
        dispatched = u;
      },
    },
  };
  const voice = { name: 'test', lang: 'fr-FR' };
  const u = queueLocalSpeech('Papa fait sourire Sarra.', cfg, {
    host,
    voice,
    onTimeline: (value) => {
      timeline = value;
    },
    onFinish: () => {
      end++;
    },
  });
  assert.equal(u, dispatched);
  assert.equal(u.voice, voice);
  assert.equal(u.lang, 'fr-FR');
  assert.equal(u.rate, 0.9);
  assert.equal(u.text, 'Papa fait sourire Sarra.');
  assert.equal(cancel, 1);
  assert.equal(timeline.startedAt, null);
  u.onstart();
  assert.equal(timeline.startedAt, 100);
  now = 600;
  u.onboundary({ charIndex: 5, elapsedTime: 0.45 });
  assert.equal(timeline.boundaryAt, 550);
  u.onend();
  u.onerror({ error: 'interrupted' });
  assert.equal(end, 1);
  assert.ok(timeline.ended);
});

function devices() {
  const log = [];
  const track = { stop: () => log.push('stop track') };
  const stream = { getTracks: () => [track] };
  const node = {
    connect: (to) => log.push(to === an ? 'source → analyser' : 'unexpected output'),
    disconnect: () => log.push('disconnect source'),
  };
  const an = {
    frequencyBinCount: 512,
    disconnect: () => log.push('disconnect analyser'),
    getByteTimeDomainData: (w) => w.fill(128),
    getByteFrequencyData: (f) => f.fill(0),
  };
  class Context {
    state = 'running';
    sampleRate = 48000;
    createAnalyser() {
      return an;
    }
    createMediaStreamSource() {
      return node;
    }
    async close() {
      log.push('close context');
      this.state = 'closed';
    }
  }
  return {
    log,
    stream,
    host: {
      navigator: {
        mediaDevices: {
          async getUserMedia(options) {
            assert.deepEqual(options, { audio: true });
            return stream;
          },
        },
      },
      AudioContext: Context,
    },
  };
}

test('ambient capture uses the original FFT with no speaker connection; stop is idempotent', async () => {
  const { log, host } = devices();
  const mic = await openAmbientMicrophone({ host });
  assert.equal(mic.an.fftSize, 1024);
  assert.equal(mic.an.smoothingTimeConstant, 0.5);
  assert.deepEqual(microphoneTargets(mic, cfg, { g: 1 }), [0, 0, 0, 0, 0]);
  mic.an.getByteTimeDomainData = (w) => w.fill(150);
  mic.an.getByteFrequencyData = (f) => f.fill(70);
  assert.ok(microphoneTargets(mic, cfg, { g: 1 }).some((v) => v > 0.1));
  assert.deepEqual(log, ['source → analyser']);
  mic.close();
  mic.close();
  assert.deepEqual(log.slice(1), ['stop track', 'disconnect source', 'disconnect analyser', 'close context']);
});

test('the original formant bands distinguish low O/U and high I, even on an 8 kHz input', async () => {
  const { host } = devices();
  const mic = await openAmbientMicrophone({ host });
  mic.ctx.sampleRate = 8000;
  mic.an.getByteTimeDomainData = (wave) => wave.fill(150);
  const captureAt = (frequency) => {
    mic.an.getByteFrequencyData = (bins) => {
      bins.fill(0);
      bins[Math.round(frequency / (mic.ctx.sampleRate / mic.an.fftSize))] = 128;
    };
    return microphoneTargets(mic, cfg, { g: 1 });
  };
  const low = captureAt(500),
    high = captureAt(3000);
  assert.ok([...low, ...high].every(Number.isFinite));
  assert.ok(low[3] > low[0] && low[4] > low[2]);
  assert.ok(high[2] > 0.5 && high[3] === 0 && high[4] === 0);
  mic.close();
});

test('a permission grant after cancellation never keeps a live track or opens a context', async () => {
  const { host, stream, log } = devices();
  let grant;
  host.navigator.mediaDevices.getUserMedia = () =>
    new Promise((resolve) => {
      grant = resolve;
    });
  const controller = new AbortController();
  const opening = openAmbientMicrophone({ host, signal: controller.signal });
  controller.abort();
  grant(stream);
  await assert.rejects(opening, { name: 'AbortError' });
  assert.deepEqual(log, ['stop track']);
});

test('if Web Audio fails after grant, the captured tracks are still stopped', async () => {
  const { host, log } = devices();
  host.AudioContext = class {
    constructor() {
      throw new Error('unavailable');
    }
  };
  await assert.rejects(openAmbientMicrophone({ host }), /unavailable/);
  assert.deepEqual(log, ['stop track']);
});
