// Microbenchmark du seul adaptateur CPU : géométrie, WebGL et audio exclus.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createVrmAdapter } from '../avatar-core/adapters/vrm.js';

const modelPath = new URL('../avatar-core/sarra7.vrm', import.meta.url);
let bytes;
try {
  bytes = await readFile(modelPath);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  throw new Error('The benchmark requires a local licensed VRM at avatar-core/sarra7.vrm.', { cause: error });
}
const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
const nodes = gltf.nodes.map(({ mesh }) => {
  const names = gltf.meshes[mesh]?.primitives[0].extras?.targetNames;
  return names ? {
    isMesh: true,
    morphTargetDictionary: Object.fromEntries(names.map((name, i) => [name, i])),
    morphTargetInfluences: names.map(() => 0),
  } : { isMesh: mesh != null };
});
let traversals = 0;
const adapter = createVrmAdapter();
await adapter.loadAvatar({ scene: { traverse(visit) { traversals++; nodes.forEach(visit); } } });
const weights = { mouthSmileLeft: 0.4, mouthSmileRight: 0.4, jawOpen: 0.2, PP: 0.3 };
for (let i = 0; i < 1000; i++) adapter.applyMorphWeights(weights);
traversals = 0;
const frames = 10000;
const start = performance.now();
for (let i = 0; i < frames; i++) adapter.applyMorphWeights(weights);
const elapsed = performance.now() - start;
console.log(`${nodes.length} nœuds · ${frames} applications · ${traversals} parcours de scène · ${elapsed.toFixed(1)} ms (CPU, hors rendu)`);
adapter.dispose();
