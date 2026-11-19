import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SARRA_PHOTOREAL_VISEME_MAPPING,
  SARRA_PHOTOREAL_RIG_SIGNATURE,
  createSarraPhotorealAvatarCore,
  createSarraPhotorealAdapter,
} from './adapters/vrm-photoreal.js';

// Noms verrouilles sur le rig reel de sarra-photoreal.vrm (ARKit + visemes VRM)
const PHOTOREAL_TARGETS = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel',
  'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker',
  'mouthRight', 'mouthRollLower', 'mouthRollUpper',
  'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight',
  'CH', 'DD', 'E', 'FF', 'PP', 'RR', 'SS', 'TH',
  'aa', 'ih', 'kk', 'nn', 'oh', 'ou', 'sil',
];

function createPhotorealFixture() {
  const mesh = {
    isMesh: true,
    morphTargetDictionary: Object.fromEntries(PHOTOREAL_TARGETS.map((name, index) => [name, index])),
    morphTargetInfluences: PHOTOREAL_TARGETS.map(() => 0),
  };
  const leftEye = { rotation: { x: 0.1, y: 0.2 } };
  const rightEye = { rotation: { x: -0.1, y: -0.2 } };
  return {
    scene: { traverse: (visit) => visit(mesh) },
    humanoid: {
      getNormalizedBoneNode: (name) => ({ leftEye, rightEye })[name] || null,
    },
    mesh,
    leftEye,
    rightEye,
  };
}

test('photoreal adapter pre-cables model identity for sarra-photoreal.vrm', () => {
  const adapter = createSarraPhotorealAdapter();
  assert.deepEqual(adapter.getModelIdentity(), {
    id: 'sarra-photoreal.vrm',
    rigSignature: SARRA_PHOTOREAL_RIG_SIGNATURE,
  });
});

test('photoreal core applies EE->E, P->PP, F->FF visime mappings through update()', async () => {
  const avatar = createPhotorealFixture();
  const core = createSarraPhotorealAvatarCore();

  assert.equal((await core.loadAvatar(avatar)).ok, true);

  for (const [viseme, morph] of [['EE', 'E'], ['P', 'PP'], ['F', 'FF']]) {
    core.setViseme(viseme, 1, 0);
    const weights = core.update(1);
    assert.ok((weights[morph] ?? 0) > 0, `${viseme} should drive morph ${morph}`);
    core.resetViseme(0);
    core.update(1);
  }
});

test('photoreal core keeps emotions working through the ARKit rig', async () => {
  const avatar = createPhotorealFixture();
  const core = createSarraPhotorealAvatarCore();

  assert.equal((await core.loadAvatar(avatar)).ok, true);
  assert.equal(core.setEmotion('joy', 1, 420).ok, true);
  core.update(1);

  assert.ok(avatar.mesh.morphTargetInfluences[avatar.mesh.morphTargetDictionary.mouthSmileLeft] > 0.4);
});

test('shipped sarra-photoreal.vrm visemes land on declared E/PP/FF targets', async (t) => {
  const { readFile } = await import('node:fs/promises');
  let bytes;
  try {
    bytes = await readFile(new URL('../SuperSarra-Photoreal/05_Exports/sarra-photoreal.vrm', import.meta.url));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return t.skip('Export photoréaliste optionnel absent du dépôt.');
  }
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const targetNames = new Set();
  for (const mesh of document.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      for (const name of primitive.extras?.targetNames || mesh.extras?.targetNames || []) {
        targetNames.add(name);
      }
    }
  }
  // les 3 morphs sur lesquels le mapping repose doivent exister
  for (const required of ['E', 'PP', 'FF', 'aa', 'ih', 'ou', 'oh', 'sil']) {
    assert.ok(targetNames.has(required), `morph requis absent du VRM: ${required}`);
  }
  // cohérence avec le mapping livré
  assert.deepEqual(Object.keys(SARRA_PHOTOREAL_VISEME_MAPPING), ['AA', 'IH', 'OU', 'EE', 'OH', 'P', 'F']);
});
