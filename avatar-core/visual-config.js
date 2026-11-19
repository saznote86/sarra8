export const AVATAR_VISUAL_CONFIG = Object.freeze({
  renderer: Object.freeze({
    antialias: true,
    pixelRatioLimit: 2.5,
    outputColorSpace: 'srgb',
    toneMapping: 'agx',
    toneMappingExposure: 0.95,
    shadows: false,
  }),
  scene: Object.freeze({
    background: '#10131b',
    environment: null,
    hemisphere: Object.freeze({
      skyColor: 0xf0f3ff,
      groundColor: 0x685951,
      intensity: 0.72,
    }),
    keyLight: Object.freeze({
      color: 0xfff5ed,
      intensity: 2.0,
      position: Object.freeze([2.6, 3.0, 2.8]),
    }),
    fillLight: Object.freeze({
      color: 0xd7e3ff,
      intensity: 0.5,
      position: Object.freeze([-3, 1, 2.5]),
    }),
    rimLight: Object.freeze({
      color: 0xffd9c2,
      intensity: 0.65,
      position: Object.freeze([-1, 3, -2]),
    }),
  }),
  camera: Object.freeze({
    fov: 32,
    near: 0.1,
    far: 100,
    fitPadding: 1.12,
    defaultZoom: 1,
  }),
});

export function createAvatarRenderer(THREE, canvas, { alpha = false, pixelRatio = 1 } = {}) {
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new RangeError('pixelRatio must be a positive finite number');
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: AVATAR_VISUAL_CONFIG.renderer.antialias,
    alpha,
  });
  renderer.setPixelRatio(Math.min(pixelRatio, AVATAR_VISUAL_CONFIG.renderer.pixelRatioLimit));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = AVATAR_VISUAL_CONFIG.renderer.toneMappingExposure;
  renderer.shadowMap.enabled = AVATAR_VISUAL_CONFIG.renderer.shadows;
  return renderer;
}

export function createStudioEnvironment(THREE, renderer, RoomEnvironment) {
  if (!renderer || typeof RoomEnvironment !== 'function' ||
      typeof THREE.PMREMGenerator !== 'function') {
    throw new TypeError('renderer and RoomEnvironment are required');
  }

  const generator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  let target;
  try {
    target = generator.fromScene(room, 0.04);
  } finally {
    try {
      room.dispose();
    } finally {
      generator.dispose();
    }
  }

  return {
    texture: target.texture,
    dispose: () => target.dispose(),
  };
}

export function configureAvatarScene(THREE, scene, { transparent = false, environment = null } = {}) {
  scene.background = transparent ? null : new THREE.Color(AVATAR_VISUAL_CONFIG.scene.background);
  scene.environment = environment || AVATAR_VISUAL_CONFIG.scene.environment;
  if ('environmentIntensity' in scene) scene.environmentIntensity = 0.7;

  const { hemisphere, keyLight, fillLight, rimLight } = AVATAR_VISUAL_CONFIG.scene;
  scene.add(new THREE.HemisphereLight(
    hemisphere.skyColor,
    hemisphere.groundColor,
    hemisphere.intensity,
  ));
  const key = new THREE.DirectionalLight(keyLight.color, keyLight.intensity);
  key.position.set(...keyLight.position);
  scene.add(key);
  for (const lightConfig of [fillLight, rimLight]) {
    const light = new THREE.DirectionalLight(lightConfig.color, lightConfig.intensity);
    light.position.set(...lightConfig.position);
    scene.add(light);
  }
  return { keyLight: key };
}

export function fitAvatarCamera(THREE, bounds, aspect, zoom = AVATAR_VISUAL_CONFIG.camera.defaultZoom) {
  if (!bounds || typeof bounds.getCenter !== 'function' || typeof bounds.getSize !== 'function') {
    throw new TypeError('bounds must be a THREE.Box3');
  }
  if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(zoom) || zoom <= 0) {
    throw new RangeError('aspect and zoom must be positive finite numbers');
  }

  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const halfFovTangent = Math.tan(THREE.MathUtils.degToRad(AVATAR_VISUAL_CONFIG.camera.fov / 2));
  const verticalDistance = size.y / (2 * halfFovTangent);
  const horizontalDistance = size.x / (2 * halfFovTangent * aspect);

  return {
    center,
    // Leave room for the front of the bounds, not just the plane through its centre.
    distance: (Math.max(verticalDistance, horizontalDistance) *
      AVATAR_VISUAL_CONFIG.camera.fitPadding + size.z / 2) / zoom,
  };
}

export function isAvatarPortraitMesh(namePath) {
  return /(?:head|face|eye|teeth|tongue|lash|brow|hair|mouth|glasses)/i.test(String(namePath));
}

export function getAvatarMeshVisibility(namePath, portraitMode, originalVisible = true, hasPortraitMeshes = true) {
  return Boolean(originalVisible) &&
    (!portraitMode || !hasPortraitMeshes || isAvatarPortraitMesh(namePath));
}

// Run once per loaded model, after VRM0 rotation and matrix updates. Reuse
// these bounds on resize; never walk skinned geometry on a camera drag.
export function measureAvatarViews(THREE, vrm) {
  vrm.scene.updateMatrixWorld(true);
  const body = new THREE.Box3().setFromObject(vrm.scene);
  const portrait = new THREE.Box3();
  const entries = [];
  vrm.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const path = [];
    for (let node = mesh; node; node = node.parent) path.push(node.name || '');
    const facial = isAvatarPortraitMesh(path.join(' '));
    entries.push({ mesh, facial, visible: mesh.visible });
    if (mesh.visible && facial) portrait.expandByObject(mesh);
  });
  const height = body.max.y - body.min.y;
  const head = vrm.humanoid?.getNormalizedBoneNode?.('head')?.getWorldPosition(new THREE.Vector3());
  const portraitHeight = portrait.max.y - portrait.min.y;
  // A single full-body mesh, unnamed meshes, or only eye meshes: frame the
  // humanoid head proportionally instead of zooming into an eye or the feet.
  const usable = !portrait.isEmpty() && portraitHeight >= height * 0.085 &&
    !(head && head.y > body.min.y + height * 0.55 && portraitHeight > height * 0.6);
  if (!usable) {
    if (head && height > 0 && Number.isFinite(height) && head.y > body.min.y + height * 0.55) {
      const h = Math.max(height * 0.18, (body.max.y - head.y) * 1.65);
      portrait.min.set(head.x - h * 0.5, head.y - h * 0.4, head.z - h * 0.5);
      portrait.max.set(head.x + h * 0.5, head.y + h * 0.6, head.z + h * 0.5);
    } else portrait.copy(body);
  }
  return {
    body, portrait,
    setPortraitOnly(enabled) {
      for (const { mesh, facial, visible } of entries) {
        mesh.visible = visible && (!enabled || !usable || facial);
      }
    },
  };
}
