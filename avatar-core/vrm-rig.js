// Some VRM 0.x exporters put targetNames on primitives rather than meshes.
// GLTFLoader r169 reads the mesh-level list only. Restore labels before the
// adapter indexes the rig; leave the loader's dictionary alone if malformed.
export function restoreVrmMorphNames({ scene, parser }) {
  scene.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.morphTargetInfluences?.length) return;
    const ref = parser?.associations?.get(mesh);
    const def = parser?.json?.meshes?.[ref?.meshes];
    if (!def) return;
    for (const names of [def.primitives?.[ref.primitives ?? 0]?.extras?.targetNames, def.extras?.targetNames]) {
      if (!Array.isArray(names) || names.length !== mesh.morphTargetInfluences.length ||
          !names.every((name) => typeof name === 'string' && name.length) || new Set(names).size !== names.length) continue;
      mesh.morphTargetDictionary = Object.fromEntries(names.map((name, index) => [name, index]));
      break;
    }
  });
}

// Direct morphs only, not expression-manager preset names. No invented target
// for a rig that does not implement a sound. Custom calibrations stay separate.
export function detectVrmVisemes(names) {
  const available = new Set(names);
  const aliases = { AA: ['aa', 'A'], IH: ['ih', 'I'], OU: ['ou', 'U'], EE: ['ee', 'E'], OH: ['oh', 'O'], P: ['PP', 'P'], F: ['FF', 'F'] };
  return Object.fromEntries(Object.entries(aliases).map(([viseme, candidates]) => {
    const target = candidates.find((candidate) => available.has(candidate));
    return [viseme, target ? { [target]: 1 } : {}];
  }));
}
