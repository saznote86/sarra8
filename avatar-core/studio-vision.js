const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function validateCaptureQuality(capture, options = {}) {
  const minWidth = options.minWidth || 160;
  const minHeight = options.minHeight || 160;
  const issues = [];
  const width = Number(capture?.width) || 0;
  const height = Number(capture?.height) || 0;
  const data = capture?.data;

  if (!width || !height || !data || data.length !== width * height * 4) {
    issues.push({ code: 'invalid-capture', severity: 'error', message: 'Capture invalide ou buffer RGBA incomplet.' });
  } else {
    if (width < minWidth || height < minHeight) issues.push({ code: 'resolution-too-low', severity: 'warning', width, height });

    let visible = 0;
    let sum = 0;
    let sumSquares = 0;
    let bright = 0;
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 16) continue;
      visible += 1;
      const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3;
      sum += luminance;
      sumSquares += luminance * luminance;
      if (luminance < 24) dark += 1;
      if (luminance > 238) bright += 1;
    }
    const mean = visible ? sum / visible : 0;
    const variance = visible ? sumSquares / visible - mean * mean : 0;
    const ratio = visible / (width * height);
    if (!visible || ratio < 0.08) issues.push({ code: 'empty-capture', severity: 'error', visibleRatio: ratio });
    if (mean < 28) issues.push({ code: 'capture-too-dark', severity: 'warning', meanLuminance: mean });
    if (mean > 227 && bright / Math.max(1, visible) > 0.35) issues.push({ code: 'capture-overexposed', severity: 'warning', meanLuminance: mean });
    if (visible && variance < 12) issues.push({ code: 'low-image-detail', severity: 'warning', variance });
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    issues,
    confidence: issues.length ? clamp(1 - issues.length * 0.18, 0, 1) : 1,
    limits: ['La qualité est estimée depuis les pixels; elle ne confirme pas un cadrage facial sémantique.'],
  };
}

export function analyzeCapture(capture, options = {}) {
  const quality = validateCaptureQuality(capture);
  if (!quality.ok) return { ok: false, quality, metrics: {}, confidence: 0, limits: quality.limits };

  const width = capture.width;
  const height = capture.height;
  const data = capture.data;
  const luminanceAt = (x, y) => {
    const index = (clamp(Math.floor(y), 0, height - 1) * width + clamp(Math.floor(x), 0, width - 1)) * 4;
    return (data[index] + data[index + 1] + data[index + 2]) / 3;
  };
  const region = (x0, y0, x1, y1) => {
    const values = [];
    for (let y = Math.floor(height * y0); y < Math.floor(height * y1); y += 1) {
      for (let x = Math.floor(width * x0); x < Math.floor(width * x1); x += 1) values.push(luminanceAt(x, y));
    }
    return values;
  };

  const eyes = region(0.22, 0.25, 0.78, 0.48);
  const mouth = region(0.28, 0.54, 0.72, 0.78);
  const upperLeft = region(0.22, 0.25, 0.50, 0.48);
  const upperRight = region(0.50, 0.25, 0.78, 0.48);
  const leftVariance = variance(upperLeft);
  const rightVariance = variance(upperRight);
  const symmetry = 1 - clamp(Math.abs(leftVariance - rightVariance) / Math.max(leftVariance, rightVariance, 1), 0, 1);
  const mouthDarkness = 1 - clamp((average(mouth) - 32) / 180, 0, 1);
  const mouthVariance = variance(mouth);
  const eyeDetail = variance(eyes);
  const mouthEdgeDensity = edgeDensity(regionNormalized(mouthRegion(data, width, height)));
  const leftEyeEdgeDensity = edgeDensity(regionNormalized(leftEyeRegion(data, width, height)));
  const rightEyeEdgeDensity = edgeDensity(regionNormalized(rightEyeRegion(data, width, height)));
  const neutral = options.neutralCapture && options.neutralCapture.data ? analyzeCapture(options.neutralCapture) : null;
  const mouthRelativeDelta = neutral?.metrics?.mouthVariance != null
    ? mouthVariance - neutral.metrics.mouthVariance.value
    : null;

  return {
    ok: true,
    quality,
    metrics: {
      faceRegion: {
        value: { x: 0.22, y: 0.25, width: 0.56, height: 0.53 },
        confidence: 0.45,
        method: 'Région centrale heuristique de la capture de tête.',
        limits: ['Ne suit pas automatiquement les contours du visage; le résultat peut varier avec le cadrage.'],
      },
      mouthOpening: {
        value: mouthVariance > 40 ? clamp(mouthDarkness * (0.35 + mouthVariance / 6000), 0, 1) : null,
        confidence: mouthVariance > 80 ? 0.45 : 0.15,
        method: 'Contraste moyen et variance normalisés dans une zone des lèvres au ratio face/largeur.',
        limits: ['Mesure indirecte; lèvres, barbe, lumière et morphs peuvent être confondus avec une ouverture.'],
      },
      mouthVariance: {
        value: mouthVariance,
        confidence: mouthVariance > 40 ? 0.45 : 0.15,
        method: 'Variance locale de luminance dans la région centrale des lèvres.',
        limits: ['Les ombres et les rides peuvent augmenter la variance sans ouvrir la bouche.'],
      },
      mouthLipVariation: {
        value: mouthEdgeDensity,
        confidence: mouthEdgeDensity > 0.02 ? 0.4 : 0.12,
        method: 'Densité de contours locaux Sobel dans la zone des lèvres.',
        limits: ['Contour du maquillage, accessoire ou transparence possible.'],
      },
      eyeDetail: {
        value: eyeDetail > 40 ? clamp(eyeDetail / 6000, 0, 1) : null,
        confidence: eyeDetail > 40 ? 0.35 : 0.12,
        method: 'Variance normalisée dans des sous-régions gauche/droite des yeux.',
        limits: ['Ne distingue pas reliably les yeux ouverts, fermés ou masqués.'],
      },
      eyelidOpening: {
        value: 'unavailable',
        confidence: 0,
        method: 'Repères anatomiques requis pour la séparation paupière/globe oculaire.',
        limits: ['Cette phase ne dispose pas de segmentation faciale fiable; aucune ouverture de paupière ne sera inventée.'],
      },
      mouthRelativeDelta: {
        value: mouthRelativeDelta,
        confidence: mouthRelativeDelta == null ? 0 : 0.35,
        method: 'Différence de variance de la bouche par rapport à une capture neutre validée.',
        limits: ['Une différence locale reste descriptive et ne prouve pas une amélioration naturelle.'],
      },
      eyeRegionalVariance: {
        value: { left: leftEyeEdgeDensity, right: rightEyeEdgeDensity, asymmetry: Math.abs(leftEyeEdgeDensity - rightEyeEdgeDensity) },
        confidence: 0.25,
        method: 'Densité Sobel indépendante dans les zones gauche/droite des yeux.',
        limits: ['Pose, perspective, cheveux, lunettes et éclairage peuvent influencer la symétrie.'],
      },
      visualSymmetry: {
        value: clamp(symmetry, 0, 1),
        confidence: 0.25,
        method: 'Comparaison des variances de luminance gauche/droite dans les zones des yeux.',
        limits: ['Asymétrie naturelle, pose, perspective et éclairage non séparés avec certitude.'],
      },
      foregroundDetail: {
        value: clamp(variance(region(0.1, 0.08, 0.9, 0.92)) / 6000, 0, 1),
        confidence: 0.6,
        method: 'Variance de luminance de la zone centrale visible.',
        limits: ['Indicateur général, pas une mesure anatomique.'],
      },
    },
    confidence: clamp(quality.confidence * 0.55, 0, 1),
    limits: ['Analyse déterministe par luminance/contraste; aucune reconnaissance anatomique ou émotionnelle n’est revendiquée.'],
  };
}

export function calculateVisualMetrics(capture) {
  return analyzeCapture(capture);
}

export function compareCaptures(before, after) {
  const qualityBefore = validateCaptureQuality(before);
  const qualityAfter = validateCaptureQuality(after);
  if (!before?.data || !after?.data || before.width !== after.width || before.height !== after.height || before.data.length !== after.data.length) {
    return { ok: false, error: 'incompatible-captures', qualityBefore, qualityAfter };
  }
  if (!qualityBefore.ok || !qualityAfter.ok) {
    return { ok: false, error: 'capture-quality-invalid', qualityBefore, qualityAfter };
  }

  let absoluteDifference = 0;
  let changedChannels = 0;
  let visibleDifference = 0;
  let visibleChannels = 0;
  for (let index = 0; index < before.data.length; index += 4) {
    const alphaDiff = Math.abs(before.data[index + 3] - after.data[index + 3]);
    if (before.data[index + 3] > 8 || after.data[index + 3] > 8) visibleChannels += 3;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(before.data[index + channel] - after.data[index + channel]);
      absoluteDifference += difference;
      if (difference > 8) changedChannels += 1;
      if (before.data[index + 3] > 8 || after.data[index + 3] > 8) visibleDifference += difference;
    }
    if (alphaDiff > 8) changedChannels += 1;
  }
  const channelCount = before.data.length * 3 / 4;
  const beforeMetrics = analyzeCapture(before);
  const afterMetrics = analyzeCapture(after);

  return {
    ok: true,
    rawDifference: {
      meanAbsoluteDifference: absoluteDifference / channelCount,
      changedPixelChannelRatio: changedChannels / (before.data.length / 4 * 4),
      normalizedVisibleDifference: visibleChannels ? visibleDifference / visibleChannels : 0,
    },
    metricsBefore: beforeMetrics.metrics,
    metricsAfter: afterMetrics.metrics,
    visualDelta: {
      mouthOpening: normalizedDelta(beforeMetrics.metrics.mouthOpening?.value, afterMetrics.metrics.mouthOpening?.value),
      eyeDetail: normalizedDelta(beforeMetrics.metrics.eyeDetail?.value, afterMetrics.metrics.eyeDetail?.value),
      visualSymmetry: normalizedDelta(beforeMetrics.metrics.visualSymmetry?.value, afterMetrics.metrics.visualSymmetry?.value),
    },
    confidence: Math.min(beforeMetrics.confidence, afterMetrics.confidence),
    qualityBefore,
    qualityAfter,
    limits: ['Une hausse ou baisse de la différence brute ne prouve pas automatiquement une amélioration.'],
  };
}

export async function waitForCaptureStability(captureFrame, options = {}) {
  if (typeof captureFrame !== 'function') throw new TypeError('captureFrame must be a function');
  const frames = options.frames || 3;
  const timeoutMs = options.timeoutMs || 2400;
  const intervalMs = options.intervalMs || 120;
  const threshold = options.threshold == null ? 1.5 : options.threshold;
  const startedAt = Date.now();
  const history = [];

  while (Date.now() - startedAt < timeoutMs) {
    const capture = await captureFrame();
    if (!capture) continue;
    const pixels = capture.data;
    history.push({ capture, fingerprint: pixels ? sampleFingerprint(pixels) : '' });
    if (history.length > frames) history.shift();
    if (history.length === frames) {
      let stable = true;
      for (let index = 1; index < history.length; index += 1) {
        const first = history[index - 1].capture;
        const current = history[index].capture;
        if (!sameDimensions(first, current)) { stable = false; break; }
        const difference = averageAbsoluteDifference(first.data, current.data);
        if (difference > threshold) { stable = false; break; }
      }
      if (stable) return { ok: true, capture: history.at(-1).capture, samples: history.length, elapsedMs: Date.now() - startedAt };
    }
    await delay(intervalMs);
  }
  const differences = [];
  for (let index = 1; index < history.length; index += 1) {
    differences.push(averageAbsoluteDifference(history[index - 1].capture.data, history[index].capture.data));
  }
  return {
    ok: false,
    error: 'capture-stability-timeout',
    samples: history.length,
    elapsedMs: Date.now() - startedAt,
    meanFrameDifference: differences.length ? average(differences) : null,
    maxFrameDifference: differences.length ? Math.max(...differences) : null,
    threshold,
  };
}

function variance(values) {
  const mean = average(values);
  return average(values.map((value) => (value - mean) ** 2));
}

function regionNormalized(values) {
  return values.map((value) => Number.isFinite(value) ? value : 0);
}

function mouthRegion(data, width, height) {
  return luminanceRegion(data, width, height, 0.28, 0.54, 0.72, 0.78);
}

function leftEyeRegion(data, width, height) {
  return luminanceRegion(data, width, height, 0.22, 0.25, 0.50, 0.48);
}

function rightEyeRegion(data, width, height) {
  return luminanceRegion(data, width, height, 0.50, 0.25, 0.78, 0.48);
}

function luminanceRegion(data, width, height, x0, y0, x1, y1) {
  const values = [];
  const startX = Math.floor(width * x0);
  const endX = Math.ceil(width * x1);
  const startY = Math.floor(height * y0);
  const endY = Math.ceil(height * y1);
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = (y * width + x) * 4;
      values.push((data[index] + data[index + 1] + data[index + 2]) / 3);
    }
  }
  return values;
}

function edgeDensity(values) {
  if (!values.length) return 0;
  let count = 0;
  let strong = 0;
  const side = Math.max(1, Math.round(Math.sqrt(values.length)));
  for (let index = side + 1; index < values.length - side; index += 1) {
    const horizontal = Math.abs(values[index + 1] - values[index - 1]);
    const vertical = Math.abs(values[index + side] - values[index - side]);
    const gradient = Math.hypot(horizontal, vertical);
    if (gradient > 4) strong += 1;
    count += 1;
  }
  return count ? strong / count : 0;
}

function normalizedDelta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return after - before;
}

function sameDimensions(first, second) {
  return first.width === second.width && first.height === second.height && first.data?.length === second.data?.length;
}

function averageAbsoluteDifference(first, second) {
  if (!first || !second || first.length !== second.length) return Infinity;
  let total = 0;
  let count = 0;
  for (let index = 0; index < first.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) total += Math.abs(first[index + channel] - second[index + channel]);
    count += 3;
  }
  return count ? total / count : Infinity;
}

function sampleFingerprint(data) {
  let hash = 2166136261;
  const step = Math.max(4, Math.floor(data.length / 4096 / 4) * 4);
  for (let index = 0; index < data.length; index += step) {
    hash ^= data[index] || 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
