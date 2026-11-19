import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { restoreVrmMorphNames, detectVrmVisemes } from './vrm-rig.js';
import { createVrmAdapter } from './adapters/vrm.js';
import { createAvatarCore } from './expression-mixer.js';

function loadedScene(meshes) {
  const objects = [], associations = new Map();
  meshes.forEach((mesh, i) => mesh.primitives.forEach((primitive, j) => {
    const count = primitive.targets?.length ?? 0;
    const object = { isMesh: true, morphTargetInfluences: Array(count).fill(0), morphTargetDictionary: Object.fromEntries(Array.from({ length: count }, (_, k) => [String(k), k])) };
    objects.push(object); associations.set(object, { meshes: i, primitives: j });
  }));
  return { objects, scene: { traverse: (visit) => objects.forEach(visit) }, parser: { associations, json: { meshes } } };
}

test('local reference VRM recovers its 66 authored names; all seven poses drive actual mesh slots', async (t) => {
  let bytes;
  try {
    bytes = await readFile(new URL('./sarra7.vrm', import.meta.url));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return t.skip('Local reference VRM is not included in the repository.');
  }
  const { meshes } = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
  const gltf = loadedScene(meshes);
  restoreVrmMorphNames(gltf);
  const adapter = createVrmAdapter();
  const core = createAvatarCore({ adapter });
  await core.loadAvatar({ scene: gltf.scene });
  const names = adapter.getAvailableExpressionTargets().morphTargets;
  assert.equal(names.length, 66);
  const mapping = detectVrmVisemes(names);
  core.setVisemeMapping(mapping);
  for (const [viseme, target] of Object.entries({ AA: 'aa', IH: 'ih', OU: 'ou', EE: 'E', OH: 'oh', P: 'PP', F: 'FF' })) {
    assert.deepEqual(mapping[viseme], { [target]: 1 });
    assert.equal(core.setViseme(viseme, 1, 80).ok, true);
    core.update(1);
    const driven = gltf.objects.filter((mesh) => Object.hasOwn(mesh.morphTargetDictionary, target));
    assert.ok(driven.length >= 2, `${target} reaches head and lower teeth`);
    for (const mesh of driven) assert.ok(mesh.morphTargetInfluences[mesh.morphTargetDictionary[target]] > 0.9);
  }
  core.dispose();
  for (const mesh of gltf.objects) assert.ok(mesh.morphTargetInfluences.every((v) => Math.abs(v) < 1e-10));
});

test('target names use the correct primitive, falling back to valid mesh names or the loader dictionary', () => {
  const gltf = loadedScene([
    { primitives: [{ targets: [{}], extras: { targetNames: ['a'] } }, { targets: [{}, {}], extras: { targetNames: ['b', 'c'] } }] },
    { extras: { targetNames: ['meshName'] }, primitives: [{ targets: [{}], extras: { targetNames: [] } }] },
    { primitives: [{ targets: [{}, {}], extras: { targetNames: ['duplicate', 'duplicate'] } }] },
  ]);
  const untouched = gltf.objects[3].morphTargetDictionary;
  restoreVrmMorphNames(gltf);
  assert.deepEqual(gltf.objects[0].morphTargetDictionary, { a: 0 });
  assert.deepEqual(gltf.objects[1].morphTargetDictionary, { b: 0, c: 1 });
  assert.deepEqual(gltf.objects[2].morphTargetDictionary, { meshName: 0 });
  assert.equal(gltf.objects[3].morphTargetDictionary, untouched);
  assert.deepEqual(detectVrmVisemes(['A', 'ee', 'E', 'PP']), { AA: { A: 1 }, IH: {}, OU: {}, EE: { ee: 1 }, OH: {}, P: { PP: 1 }, F: {} });
});
