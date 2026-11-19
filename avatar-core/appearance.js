const EYES = /^(AvatarLeftEyeball|AvatarRightEyeball)$/i;

// Only for the bundled white-clay Sarra. The albedo carries sculpted facial
// detail; its alpha channel actually cuts out the individual eyelashes. Do not
// detach those maps (or the original normals). Leave both irises untouched.
export function applyDefaultAvatarAppearance(model) {
  if (typeof model?.scene?.traverse !== 'function') {
    throw new TypeError('model must contain a traversable scene');
  }
  const visited = new Set();
  model.scene.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material || visited.has(material) || EYES.test(material.name)) continue;
      visited.add(material);
      material.color?.set(0xf4f4f4);
      material.shadeColorFactor?.set(0xf4f4f4);
      material.emissive?.set(0x000000);
      if ('metalness' in material) material.metalness = 0;
      if ('roughness' in material) material.roughness = /teeth/i.test(material.name) ? 0.55 : 0.85;
    }
  });
}
