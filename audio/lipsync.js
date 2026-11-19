// Calculs d'origine extraits de la page Web/Electron, sans audio ni horloge
// simulés. Le navigateur et l'overlay passent leurs mêmes sources à ce code.
import { VOWELS as V, CHANNELS as CH } from './profile.js';

export function build(text) {
  const T = String(text || '').toLocaleLowerCase('fr-FR'),
    seq = [];
  for (let i = 0; i < T.length; i++) {
    const c = T[i],
      n = T[i + 1] || ' ',
      pair = c + n,
      tri = T.slice(i, i + 3);
    let v = -1,
      w = 0,
      d = 0.2,
      cl = 0,
      f = 0,
      skip = 0;
    if (/[.!?…]/.test(c)) {
      d = 0.32;
    } else if (/[,;:]/.test(c)) {
      d = 0.16;
    } else if (/\s|['’]/.test(c)) {
      d = 0.04;
    } else {
      if (tri === 'eau') {
        v = 3;
        skip = 2;
      } else if (['ain', 'aim', 'ein', 'eim'].includes(tri)) {
        v = 1;
        skip = 2;
      } else if (pair === 'ph') {
        f = 1;
        d = 0.28;
        skip = 1;
      } else if (pair === 'ch' || pair === 'sh') {
        d = 0.22;
        skip = 1;
      } else if (pair === 'gn') {
        d = 0.22;
        skip = 1;
      } else if (pair === 'qu') {
        d = 0.18;
        skip = 1;
      } else if (pair === 'gu' && /[eiéèêëîï]/.test(T[i + 2] || '')) {
        d = 0.18;
        skip = 1;
      } else if (pair === 'th') {
        d = 0.2;
        skip = 1;
      } else if (pair === 'wh') {
        v = 4;
        skip = 1;
      } else if (pair === 'au') {
        v = 3;
        skip = 1;
      } else if (pair === 'ou') {
        v = 4;
        skip = 1;
      } else if (pair === 'eu' || pair === 'œu') {
        v = 1;
        skip = 1;
      } else if (['an', 'am', 'en', 'em'].includes(pair)) {
        v = 0;
        skip = 1;
      } else if (['on', 'om'].includes(pair)) {
        v = 3;
        skip = 1;
      } else if (['in', 'im', 'un', 'um', 'yn', 'ym'].includes(pair)) {
        v = 1;
        skip = 1;
      } else if (pair === 'ai' || pair === 'ei') {
        v = 1;
        skip = 1;
      } else if (pair === 'oi') {
        v = 3;
      } else if (/[aàâä]/.test(c)) v = 0;
      else if (/[oôö]/.test(c)) v = 3;
      else if (/[uùûü]/.test(c)) v = 4;
      else if (/[eéèêëœ]/.test(c)) v = 1;
      else if (/[iîïy]/.test(c)) v = 2;
      else if (c === 'w') v = 4;
      if (v >= 0) {
        const silentSchwa =
          c === 'e' &&
          !skip &&
          (!/[a-zàâäéèêëîïôöùûü]/.test(n) || (n === 's' && !/[a-zàâäéèêëîïôöùûü]/.test(T[i + 2] || '')));
        w = silentSchwa ? 0 : 1;
        d = silentSchwa ? 0.12 : 1;
      } else if (skip) {
        /* Graphème multi-lettres déjà traité (ph, ch, gn, qu, gu, th) :
           la lettre initiale ne doit pas rouvrir une consonne isolée. */
      } else if (/[bpm]/.test(c)) {
        cl = 1;
        d = 0.48;
      } else if (/[fv]/.test(c)) {
        f = 1;
        d = 0.28;
      } else if (/[a-z0-9ç]/.test(c)) {
        d = 0.22;
      }
    }
    seq.push({ v, w, d, cl, f, pos: i, end: i + skip + 1 });
    i += skip;
  }
  return seq;
}
function normalizeWord(text) {
  return String(text || '')
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
export function createSpeechTimeline(text, cfg, alignment = [], duration = 0) {
  const raw = build(text),
    seq = [],
    words = Array.from(String(text || '').matchAll(/[\p{L}\p{N}]+/gu), (m) => ({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    }));
  let covered = 0,
    matchedWords = 0,
    cursor = 0;
  if (Array.isArray(alignment) && alignment.length && words.length) {
    for (const mark of alignment) {
      const target = normalizeWord(mark.text),
        start = Number(mark.start),
        span = Number(mark.duration);
      if (!target || !Number.isFinite(start) || !Number.isFinite(span) || span <= 0) continue;
      let wordIndex = -1;
      for (let j = cursor; j < Math.min(words.length, cursor + 4); j++) {
        if (normalizeWord(words[j].text) === target) {
          wordIndex = j;
          break;
        }
      }
      if (wordIndex < 0) continue;
      const word = words[wordIndex],
        parts = raw.filter((e) => e.pos >= word.start && e.pos < word.end);
      if (!parts.length) continue;
      const weight = parts.reduce((sum, e) => sum + e.d, 0) || 1;
      let offset = 0;
      for (const part of parts) {
        const partDuration = (span * part.d) / weight;
        seq.push({ ...part, charEnd: part.end, start: start + offset, end: start + offset + partDuration });
        offset += partDuration;
        covered++;
      }
      matchedWords++;
      cursor = wordIndex + 1;
    }
  }
  const aligned =
    words.length > 0 && matchedWords === words.length && covered >= Math.max(1, Math.ceil(raw.length * 0.35));
  if (!aligned) {
    seq.length = 0;
    const weight = raw.reduce((sum, e) => sum + e.d, 0) || 1;
    const estimated = Math.max(
      0.25,
      Number.isFinite(duration) && duration > 0
        ? duration
        : String(text || '').replace(/\s/g, '').length / Math.max(1, cfg.cps * cfg.rate),
    );
    let offset = 0;
    for (const part of raw) {
      const partDuration = (estimated * part.d) / weight;
      seq.push({ ...part, charEnd: part.end, start: offset, end: offset + partDuration });
      offset += partDuration;
    }
    duration = estimated;
  } else duration = Number.isFinite(duration) && duration > 0 ? duration : Math.max(...seq.map((e) => e.end));
  seq.sort((a, b) => a.start - b.start);
  return {
    seq,
    total: duration,
    p: 0,
    ended: false,
    i: 0,
    startedAt: null,
    audioDriven: false,
    aligned,
    boundaryAt: null,
    boundaryPlayhead: 0,
    segmentScale: 1,
    lastBoundary: null,
  };
}
export function syncSpeechBoundary(tts, charIndex, elapsedTime, now = performance.now()) {
  if (!tts) return false;
  const i = tts.seq.findIndex((part) => part.pos <= charIndex && part.charEnd > charIndex);
  if (i < 0) return false;
  const part = tts.seq[i],
    elapsed = Number(elapsedTime),
    previous = tts.lastBoundary;
  if (Number.isFinite(elapsed) && previous && elapsed > previous.elapsed) {
    const expectedDelta = part.start - previous.playhead,
      actualDelta = elapsed - previous.elapsed;
    if (expectedDelta > 0.04 && actualDelta > 0.04) {
      const measured = Math.max(0.55, Math.min(1.8, actualDelta / expectedDelta));
      tts.segmentScale = tts.segmentScale * 0.65 + measured * 0.35;
    }
  }
  const boundaryAt =
    Number.isFinite(elapsed) && tts.startedAt != null ? Math.min(now, tts.startedAt + elapsed * 1000) : now;
  tts.i = i;
  tts.boundaryAt = Math.max(tts.startedAt || 0, boundaryAt);
  tts.boundaryPlayhead = part.start;
  tts.lastBoundary = Number.isFinite(elapsed) ? { elapsed, playhead: part.start } : null;
  return true;
}

export function microphoneTargets(m, cfg, micEnv) {
  m.an.getByteTimeDomainData(m.w);
  let s = 0;
  for (const x of m.w) {
    const d = (x - 128) / 128;
    s += d * d;
  }
  const raw = Math.sqrt(s / m.w.length),
    lvl = Math.min(1, raw * cfg.sens * 4);
  // AGC : normalisation adaptative du niveau voix (attaque lente, bornée), compense la distance au micro
  if (lvl > cfg.gate && lvl < 0.98) micEnv.g += (Math.min(2.5, Math.max(0.4, 0.78 / lvl)) - micEnv.g) * 0.02;
  const loud = Math.min(1, lvl * micEnv.g);
  m.an.getByteFrequencyData(m.f);
  const hz = m.ctx.sampleRate / m.an.fftSize,
    B = [
      [250, 750],
      [750, 1400],
      [1400, 2400],
      [2400, 4000],
    ].map(([a, b]) => {
      let e = 0;
      // À 8 kHz le bord à 4 kHz est juste après le dernier bin de la FFT.
      const last = Math.min(m.f.length - 1, Math.floor(b / hz));
      for (let k = Math.floor(a / hz); k <= last; k++) e += m.f[k];
      return e;
    }),
    tt = B.reduce((a, b) => a + b, 1),
    n = B.map((x) => x / tt);
  const r = [
      0.2 * n[0] + n[1],
      0.6 * n[1] + 0.9 * n[2],
      0.5 * n[2] + n[3],
      n[0] + 0.3 * n[1],
      Math.max(0, n[0] - 0.5 * n[1] - n[2]),
    ],
    mx = Math.max(...r, 1e-6);
  return r.map((x) => (x / mx) ** cfg.sharp * loud);
}

const unity = () => 1;
// Mélange la piste vocale aux cibles ambiantes puis rend la timeline active.
export function mixSpeechTargets(t, st, tts, cfg, dt, now, audioTime = null, readLevel = unity) {
  if (!tts || tts.ended || !tts.seq.length) return null;
  if (tts.audioDriven && audioTime != null) tts.p = audioTime;
  else if (tts.boundaryAt != null)
    tts.p = tts.boundaryPlayhead + Math.max(0, now - tts.boundaryAt) / 1000 / tts.segmentScale;
  else if (tts.startedAt != null) tts.p = (now - tts.startedAt) / 1000;
  const pe = tts.p + cfg.lat / 1000;
  if (pe >= tts.total) {
    if (tts.ended || pe > tts.total + 1) tts = null;
  } else {
    const seq = tts.seq;
    let i = Math.min(tts.i, seq.length - 1);
    while (i > 0 && seq[i].start > pe) i--;
    while (i < seq.length - 1 && seq[i + 1].start <= pe) i++;
    tts.i = i;
    const current = seq[i],
      next = seq[i + 1],
      follow = readLevel(dt);
    const apply = (part, weight) => {
      if (!part || weight <= 0) return;
      if (part.v >= 0) t[part.v] = Math.max(t[part.v], part.w * weight * follow);
      if (part.cl) {
        t[5] = Math.max(t[5], cfg.clos * weight);
        if (weight > 0.05) st.closing = true;
      }
      if (part.f) t[6] = Math.max(t[6], Math.min(1, cfg.fv * 2) * weight);
    };
    let blend = 0;
    const active = pe >= current.start && pe <= current.end;
    const lead = next ? Math.min(0.075, Math.max(0, (current.end - current.start) * 0.45)) : 0;
    if (active && next && next.start <= current.end + 0.03) {
      if (lead > 0) blend = applySmoothCurve((pe - (current.end - lead)) / lead);
    }
    /* Anticipation naturelle : les articulateurs préparent le phonème suivant
       avant la fin du phonème courant. `antic` (voyelles) et `consonantLead`
       (P/B/M, F/V) sont absents des profils historiques : 0 conserve donc
       exactement le comportement d’origine. */
    let pre = 0;
    const anticip = Math.max(0, Math.min(0.2, (Number.isFinite(cfg.antic) ? cfg.antic : 0) / 1000));
    const consonantLead = Math.max(0, Math.min(0.2, (Number.isFinite(cfg.consonantLead) ? cfg.consonantLead : 0) / 1000));
    const coart = Math.max(0, Math.min(1, Number.isFinite(cfg.coart) ? cfg.coart : 0));
    if (active && next && (anticip > 0 || consonantLead > 0)) {
      const isConsonant = next.cl || next.f;
      /* Le window d’anticipation est borné à 40 % de la durée du phonème
         courant, identique au lead et évite que la préparation ne couvre
         tout le phonème sur des syllabes longues. */
      const maxWindow = (current.end - current.start) * 0.4;
      const window = isConsonant ? Math.min(Math.max(anticip, consonantLead), maxWindow) : Math.min(anticip, maxWindow);
      /* La préparation occupe les `window` secondes qui précèdent le
         chevauchement de fin de phonème, sans jamais remonter avant son
         début : elle reste donc toujours audible, même sur une syllabe
         courte, et ne double jamais le blend existant. */
      const preEnd = current.end - lead;
      const preStart = Math.max(current.start, preEnd - window);
      if (window > 0 && preEnd > preStart && pe >= preStart && pe < preEnd) {
        const ramp = applySmoothCurve((pe - preStart) / (preEnd - preStart));
        const maxWeight = isConsonant ? 0.65 : 0.3;
        pre = ramp * maxWeight * (0.35 + 0.65 * coart);
      }
    }
    /* Coarticulation vocalique étendue : transition douce entre voyelles
       même sans anticipation explicite, basée sur la proximité formante.
       Gated sur les réglages naturels pour préserver le profil historique. */
    if (active && next && current.v >= 0 && next.v >= 0 && current.v !== next.v && (anticip > 0 || consonantLead > 0)) {
      const vowelDistance = Math.abs(current.v - next.v);
      const proximity = vowelDistance <= 1 ? 0.4 : vowelDistance === 2 ? 0.25 : 0.1;
      const midPoint = (current.end + next.start) / 2;
      const transitionWidth = Math.min(0.08, (next.start - current.end) * 0.6 + 0.02);
      if (transitionWidth > 0 && Math.abs(pe - midPoint) < transitionWidth) {
        const ramp = applySmoothCurve(0.5 + (pe - midPoint) / (2 * transitionWidth));
        const vBlend = ramp * proximity * coart;
        t[current.v] = Math.max(t[current.v], (1 - vBlend) * current.w * follow);
        t[next.v] = Math.max(t[next.v], vBlend * next.w * follow);
      }
    }
    const totalBlend = Math.min(1, blend + pre);
    apply(current, active ? 1 - totalBlend : 0);
    apply(next, active ? totalBlend : 0);
  }
  return tts;
}

/* Avance un curseur de visèmes en respectant la durée relative de chaque
   phonème (`d`). Les consonnes et les espaces traversent donc la timeline plus
   vite que les voyelles, au lieu d’un caractère par tick. */
export function advanceVisemeCursor(seq, cursor, dt, cps, rate = 1) {
  const length = Array.isArray(seq) ? seq.length : 0;
  if (!length) return 0;
  const max = length - 0.000001;
  let value = Math.max(0, Math.min(max, Number(cursor) || 0));
  const speed = Math.max(0.1, Number(cps) || 14) * Math.max(0.1, Number(rate) || 1);
  let remaining = Math.max(0, Number(dt) || 0) * speed;
  let guard = 0;
  while (remaining > 1e-6 && value < max && guard++ < 512) {
    const index = Math.floor(value);
    const part = seq[index];
    const fraction = value - index;
    const weight = Math.max(0.02, Number(part && part.d) || 0.2);
    const need = (1 - fraction) * weight;
    if (remaining < need) {
      value += remaining / weight;
      remaining = 0;
    } else {
      remaining -= need;
      value = index + 1;
    }
  }
  return Math.min(max, value);
}

/* Échantillonne la cible de visèmes à une position de curseur, avec
   anticipation du phonème suivant. Retourne null sur un silence sans visème. */
export function sampleVisemeTargets(seq, cursor, cfg = {}) {
  const length = Array.isArray(seq) ? seq.length : 0;
  if (!length) return null;
  const max = length - 0.000001;
  const value = Math.max(0, Math.min(max, Number(cursor) || 0));
  const channelOf = (entry) => (!entry ? -1 : entry.v >= 0 ? entry.v : entry.cl ? 5 : entry.f ? 6 : -1);
  const index = Math.floor(value);
  let channel = channelOf(seq[index]);
  if (channel < 0) {
    for (let i = index - 1; i >= 0; i--) {
      channel = channelOf(seq[i]);
      if (channel >= 0) break;
    }
  }
  if (channel < 0) return null;
  const fraction = Math.max(0, Math.min(1, value - index));
  const coart = Math.max(0, Math.min(1, Number.isFinite(cfg.coart) ? cfg.coart : 0.55));
  const nextChannel = channelOf(seq[index + 1]);
  const blendStart = Math.max(0.42, 1 - (0.18 + coart * 0.3));
  let blend = 0;
  if (nextChannel >= 0 && nextChannel !== channel && fraction > blendStart) {
    const ramp = applySmoothCurve((fraction - blendStart) / (1 - blendStart));
    const isConsonant = nextChannel === 5 || nextChannel === 6;
    blend = ramp * (isConsonant ? 0.8 : 0.5) * (0.45 + 0.55 * coart);
  }
  const out = [0, 0, 0, 0, 0, 0, 0];
  out[channel] = Math.max(0, 1 - blend);
  if (blend > 0) out[nextChannel] = blend;
  return out;
}

/* Courbe de lissage SmoothStep (3x²–2x³) appliquée aux poids de morphs :
   adoucit les transitions médianes pour éviter les pics brusques qui font « rouler » les lèvres
   (conflit jawOpen × mouthPucker/funnel sur les visèmes OU/AH). curveFactor est porté par les
   coefficients cfg.map (poids par phonème). */
function applySmoothCurve(raw) {
  const x = Math.max(0, Math.min(1, raw));
  return x * x * (3 - 2 * x);
}
function shape(t, cfg) {
  const talk = t.reduce((a, b) => a + b, 0) > cfg.gate;
  const u = CH.map((o, r) => {
    let y =
      (r < 5 ? V.reduce((a, i, c) => a + cfg['x_' + o + i] * t[c], 0) : t[r]) * cfg.gain * cfg['g_' + o] +
      (talk ? cfg['b_' + o] : 0);
    if (o == 'O' || o == 'U') y *= cfg.pucker;
    if (o == 'I' || o == 'E') y *= cfg.stretch;
    return talk ? Math.max(0, Math.min(cfg['m_' + o], y)) : 0;
  });
  const op = u[0] + u[1] + u[3];
  if (op > cfg.cap) {
    const k = cfg.cap / op;
    u[0] *= k;
    u[1] *= k;
    u[3] *= k;
  }
  if (!talk) u[0] = cfg.idle;
  return { u, talk };
}

export function createMouthState() {
  return { s: [0, 0, 0, 0, 0, 0, 0], h: [0, 0, 0, 0, 0, 0, 0], jo: 0, closing: false };
}

export function advanceMouth(st, targets, cfg, dt, now) {
  const { u, talk } = shape(targets, cfg);
  CH.forEach((v, i) => {
    const tg = u[i] * (1 + cfg.jit * 0.3 * Math.sin(now * 0.003 + i * 1.4) * Math.sin(now * 0.0017 + i)),
      s = st.s[i];
    if (tg >= s * 0.98) st.h[i] = now;
    const tc =
      tg > s
        ? cfg.atk
        : now - st.h[i] < cfg.hold
          ? 1e9
          : talk && !st.closing
            ? cfg.rel
            : Math.max(5, cfg.clo * (st.closing ? 1 - 0.8 * cfg.clos : 1));
    st.s[i] += (tg - s) * (1 - Math.exp((-dt * 1000) / tc));
  });
  const jt = Math.min(1.2, V.reduce((a, v, i) => a + cfg['jw' + v] * st.s[i], 0) * cfg.jawG);
  st.jo += (jt - st.jo) * (1 - Math.exp((-dt * 1000) / cfg.jawLag));
  return talk;
}

export function addVisemeMorphs(st, cfg, inc) {
  CH.forEach((v, i) => {
    const s = st.s[i];
    if (s > 0.001) for (const n in cfg.map[v]) inc(n, applySmoothCurve(s) * cfg.map[v][n]);
  });
}

export function addMouthAccents(st, cfg, now, inc) {
  inc('jawForward', cfg.jawFwd * (st.s[3] + st.s[4]));
  const sw = Math.sin(now * 0.004) * cfg.jawSway * st.jo * 0.5;
  inc(sw > 0 ? 'jawLeft' : 'jawRight', Math.abs(sw));
  const sm = Math.min(1, cfg.smile0 + (cfg.smile * (st.s[1] + st.s[2])) / 1.2);
  inc('mouthSmileLeft', sm);
  inc('mouthSmileRight', sm);
}
