import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarCore } from './index.js';
import { createVrmAdapter } from './adapters/vrm.js';

function createVrmFixture() {
  const mesh = {
    isMesh: true,
    morphTargetDictionary: { mouthSmileLeft: 0, mouthSmileRight: 1, eyeBlinkLeft: 2, eyeBlinkRight: 3 },
    morphTargetInfluences: [0.1, 0.1, 0, 0],
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

test('VRM adapter connects a loaded VRM, exposes its targets, and restores applied state on dispose', async () => {
  const modelIdentity = {
    id: 'sarra7.vrm',
    fingerprint: 'sha256-fixture',
    rigSignature: 'rig-fixture',
  };
  const avatar = createVrmFixture();
  const adapter = createVrmAdapter();
  const core = createAvatarCore({ adapter });

  assert.equal((await core.loadAvatar(avatar, { modelIdentity })).ok, true);
  assert.deepEqual(core.getModelIdentity(), modelIdentity);
  assert.deepEqual(core.getBlinkCapabilities(), { left: true, right: true });
  assert.equal(core.setEmotion('joie').ok, true);
  assert.equal(core.setGaze(1, -1).ok, true);
  assert.equal(core.setBlink(1).ok, true);
  const weights = core.update(0.1);
  assert.ok(weights.mouthSmileLeft > 0);
  assert.ok(avatar.mesh.morphTargetInfluences[0] > 0.1);
  assert.ok(avatar.leftEye.rotation.y > 0.2);
  assert.ok(avatar.leftEye.rotation.x < 0.1);

  assert.deepEqual(core.dispose(), { ok: true });
  assert.deepEqual(core.dispose(), { ok: true });
  assert.deepEqual(avatar.mesh.morphTargetInfluences, [0.1, 0.1, 0, 0]);
  assert.deepEqual(avatar.leftEye.rotation, { x: 0.1, y: 0.2 });
  assert.deepEqual(avatar.rightEye.rotation, { x: -0.1, y: -0.2 });
  assert.deepEqual(core.getModelIdentity(), {});
  assert.equal(core.setEmotion('joie').error, 'core-disposed');
  assert.throws(() => core.update(0.016), /core-disposed/);
});

test('VRM adapter rejects an invalid avatar and accepts model identity updates', async () => {
  const adapter = createVrmAdapter();
  assert.deepEqual(await adapter.loadAvatar({}), { ok: false, error: 'invalid-vrm-avatar' });
  assert.deepEqual(adapter.setModelIdentity({ id: 'sarra7.vrm' }), {
    ok: true,
    modelIdentity: { id: 'sarra7.vrm' },
  });
  assert.deepEqual(adapter.getModelIdentity(), { id: 'sarra7.vrm' });
});

test('VRM adapter warns when a requested expression is absent from the rig', async () => {
  const warnings = [];
  const avatar = createVrmFixture();
  const adapter = createVrmAdapter({ logger: { warn: (message) => warnings.push(message) } });
  await adapter.loadAvatar(avatar);
  adapter.applyMorphWeights({ missingExpression: 0.8 });
  assert.deepEqual(warnings, ['[VRM] Expression demandée absente du rig: missingExpression']);
});

test('local Sarra VRM visibly applies a requested facial emotion', async (t) => {
  let bytes;
  try {
    bytes = await (await import('node:fs/promises')).readFile(new URL('./sarra7.vrm', import.meta.url));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return t.skip('Local reference VRM is not included in the repository.');
  }
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const targetNames = new Set();
  for (const mesh of document.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      for (const name of primitive.extras?.targetNames || mesh.extras?.targetNames || []) targetNames.add(name);
    }
  }
  const names = [...targetNames];
  const mesh = {
    isMesh: true,
    morphTargetDictionary: Object.fromEntries(names.map((name, index) => [name, index])),
    morphTargetInfluences: names.map(() => 0),
  };
  const core = createAvatarCore({ adapter: createVrmAdapter() });
  await core.loadAvatar({ scene: { traverse: (visit) => visit(mesh) } });

  const request = core.setEmotion('joy', 1, 420);
  assert.equal(request.ok, true);
  const weights = core.update(1);

  assert.ok(weights.mouthSmileLeft > 0.4);
  assert.ok(weights.cheekSquintLeft > 0.15);
  assert.ok(mesh.morphTargetInfluences[mesh.morphTargetDictionary.mouthSmileLeft] > 0.4);
});

test('indexes the rig once; reuses bindings and eye bones for every animation frame', async () => {
  const avatar = createVrmFixture();
  let scans = 0, boneReads = 0;
  const visit = avatar.scene.traverse, lookup = avatar.humanoid.getNormalizedBoneNode;
  avatar.scene.traverse = (fn) => { scans++; visit(fn); };
  avatar.humanoid.getNormalizedBoneNode = (name) => { boneReads++; return lookup(name); };
  const adapter = createVrmAdapter();
  await adapter.loadAvatar(avatar);
  for (let frame = 0; frame < 120; frame++) {
    adapter.getAvailableExpressionTargets().morphTargets.length = 0; // cannot mutate the cache
    adapter.getGazeCapabilities(); adapter.getBlinkCapabilities(); adapter.applyGaze({ x: 0.01, y: -0.01 });
    adapter.applyMorphWeights({ mouthSmileLeft: 0.25, mouthSmileRight: 0.5 });
  }
  assert.equal(scans, 1);
  assert.equal(boneReads, 2);
  assert.ok(Math.abs(avatar.mesh.morphTargetInfluences[0] - 0.35) < 1e-10);
  adapter.dispose();
  assert.ok(Math.abs(avatar.mesh.morphTargetInfluences[0] - 0.1) < 1e-10);
});

test('swapping models restores the old rig, forgets missing targets and preserves other layers', async () => {
  const warnings = [];
  const first = createVrmFixture(), second = createVrmFixture();
  second.mesh.morphTargetDictionary = { newTarget: 0, invalidIndex: 7 };
  const adapter = createVrmAdapter({ logger: { warn: (message) => warnings.push(message) } });
  await adapter.loadAvatar(first);
  adapter.applyGaze({ x: 0.05, y: -0.05 });
  for (let i = 0; i < 10; i++) adapter.applyMorphWeights({ mouthSmileLeft: 0.4, missing: 1 });
  assert.deepEqual(adapter.getAppliedWeights(), { mouthSmileLeft: 0.4 });
  assert.equal(warnings.length, 1);
  first.mesh.morphTargetInfluences[0] += 0.25;
  assert.equal((await adapter.loadAvatar({})).ok, false);
  assert.ok(adapter.isLoaded());
  await adapter.loadAvatar({ userData: { vrm: second } });
  assert.ok(Math.abs(first.mesh.morphTargetInfluences[0] - 0.35) < 1e-10);
  assert.deepEqual(first.leftEye.rotation, { x: 0.1, y: 0.2 });
  assert.deepEqual(adapter.getAvailableExpressionTargets(), { morphTargets: ['newTarget'] });
  assert.deepEqual(adapter.getBlinkCapabilities(), { left: false, right: false });
  adapter.applyMorphWeights({ newTarget: 0.6, missing: 1, mouthSmileLeft: NaN });
  assert.deepEqual(adapter.getAppliedWeights(), { newTarget: 0.6 });
  assert.equal(warnings.length, 2); // fresh warning for a new rig
  adapter.dispose(); adapter.dispose();
  assert.deepEqual(adapter.getAvailableExpressionTargets(), { morphTargets: [] });
  assert.deepEqual(adapter.getAppliedWeights(), {});
  assert.ok(Math.abs(second.mesh.morphTargetInfluences[0] - 0.1) < 1e-10);
});
