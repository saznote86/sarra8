function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readModelIdentity(value = {}) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    ['id', 'fingerprint', 'rigSignature']
      .filter((name) => typeof value[name] === 'string' && value[name].length > 0)
      .map((name) => [name, value[name]]),
  );
}

export function createVrmAdapter({ modelIdentity = {}, logger = console } = {}) {
  let vrm = null;
  let identity = readModelIdentity(modelIdentity);
  // One morph may drive several meshes (e.g. head AND lower teeth).
  const bindings = new Map();
  const eyes = new Map();
  const active = [];
  const warned = new Set();
  let appliedWeights = Object.create(null);

  function clearMorphWeights() {
    // Subtract our layer, not the whole influence: other animation can coexist.
    for (const binding of active) binding.influences[binding.index] -= binding.weight;
    active.length = 0;
    appliedWeights = Object.create(null);
  }

  function releaseRig() {
    clearMorphWeights();
    for (const { rotation, x, y } of eyes.values()) {
      rotation.x = x;
      rotation.y = y;
    }
    eyes.clear();
    bindings.clear();
    warned.clear();
    vrm = null;
  }

  return {
    async loadAvatar(source, options = {}) {
      const candidate = source?.scene && typeof source.scene.traverse === 'function'
        ? source
        : source?.userData?.vrm;
      if (!candidate?.scene || typeof candidate.scene.traverse !== 'function') {
        return { ok: false, error: 'invalid-vrm-avatar' };
      }

      releaseRig();
      vrm = candidate;
      identity = readModelIdentity(options.modelIdentity || identity);
      vrm.scene.traverse((mesh) => {
        const influences = mesh.morphTargetInfluences;
        if (!mesh.isMesh || !influences || !mesh.morphTargetDictionary) return;
        for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
          if (!Number.isInteger(index) || index < 0 || index >= influences.length) continue;
          if (!bindings.has(name)) bindings.set(name, []);
          bindings.get(name).push({ influences, index, weight: 0 });
        }
      });
      for (const name of ['leftEye', 'rightEye']) {
        const rotation = vrm.humanoid?.getNormalizedBoneNode?.(name)?.rotation;
        if (rotation) eyes.set(name, { rotation, x: rotation.x, y: rotation.y });
      }
      return { ok: true, avatar: vrm, modelIdentity: { ...identity } };
    },

    isLoaded: () => !!vrm,

    setModelIdentity(value) {
      if (!isRecord(value)) return { ok: false, error: 'invalid-model-identity' };
      identity = readModelIdentity({ ...identity, ...value });
      return { ok: true, modelIdentity: { ...identity } };
    },

    getModelIdentity: () => ({ ...identity }),
    getAvailableExpressionTargets: () => ({ morphTargets: [...bindings.keys()] }),
    getGazeCapabilities: () => ({ leftEye: eyes.has('leftEye'), rightEye: eyes.has('rightEye'), lookAt: false }),
    getBlinkCapabilities: () => ({ left: bindings.has('eyeBlinkLeft'), right: bindings.has('eyeBlinkRight') }),

    applyGaze(gaze) {
      for (const { rotation, x, y } of eyes.values()) {
        rotation.y = y + gaze.x;
        rotation.x = x + gaze.y;
      }
    },

    clearMorphWeights,

    applyMorphWeights(weights = {}) {
      clearMorphWeights();
      for (const [name, weight] of Object.entries(weights)) {
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const targets = bindings.get(name);
        if (!targets) {
          if (vrm && !warned.has(name) && typeof logger?.warn === 'function') {
            warned.add(name);
            logger.warn(`[VRM] Expression demandée absente du rig: ${name}`);
          }
          continue;
        }
        for (const binding of targets) {
          binding.influences[binding.index] += weight;
          binding.weight = weight;
          active.push(binding);
        }
        appliedWeights[name] = weight;
      }
    },

    getAppliedWeights: () => ({ ...appliedWeights }),

    dispose() {
      releaseRig();
      identity = {};
    },
  };
}
