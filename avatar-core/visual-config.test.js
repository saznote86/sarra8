import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVATAR_VISUAL_CONFIG,
  configureAvatarScene,
  createAvatarRenderer,
  createStudioEnvironment,
  fitAvatarCamera,
  getAvatarMeshVisibility,
  isAvatarPortraitMesh,
} from './visual-config.js';

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.set(x, y, z);
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
}

class Color {
  constructor(value) {
    this.value = value;
  }
}

class Light {
  constructor(...args) {
    this.args = args;
    this.color = args[0];
    this.intensity = args.at(-1);
    this.position = new Vector3();
  }
}

class WebGLRenderer {
  constructor(options) {
    this.options = options;
    this.shadowMap = {};
  }

  setPixelRatio(value) {
    this.pixelRatio = value;
  }
}

const THREE = {
  Color,
  DirectionalLight: Light,
  HemisphereLight: Light,
  MathUtils: { degToRad: (degrees) => degrees * Math.PI / 180 },
  AgXToneMapping: 'agx',
  PMREMGenerator: class {
    constructor(renderer) {
      this.renderer = renderer;
      THREE.generator = this;
    }

    fromScene(scene, sigma) {
      this.scene = scene;
      this.sigma = sigma;
      return { texture: THREE.environmentTexture, dispose: () => { THREE.targetDisposed = true; } };
    }

    dispose() {
      THREE.generatorDisposed = true;
    }
  },
  SRGBColorSpace: 'srgb',
  Vector3,
  WebGLRenderer,
};

test('shared renderer configuration uses natural tone mapping and caps pixel ratio', () => {
  const canvas = {};
  const renderer = createAvatarRenderer(THREE, canvas, { alpha: true, pixelRatio: 3 });

  assert.deepEqual(renderer.options, { canvas, antialias: true, alpha: true });
  assert.equal(renderer.pixelRatio, 2.5);
  assert.equal(renderer.outputColorSpace, THREE.SRGBColorSpace);
  assert.equal(renderer.toneMapping, THREE.AgXToneMapping);
  assert.equal(renderer.toneMappingExposure, AVATAR_VISUAL_CONFIG.renderer.toneMappingExposure);
  assert.equal(renderer.shadowMap.enabled, false);
  assert.throws(() => createAvatarRenderer(THREE, canvas, { pixelRatio: 0 }), /pixelRatio/);
});

test('studio environment is prefiltered and can be disposed independently of the renderer', () => {
  class RoomEnvironment {
    dispose() {
      THREE.roomDisposed = true;
    }
  }
  THREE.environmentTexture = {};
  THREE.generatorDisposed = false;
  THREE.roomDisposed = false;
  THREE.targetDisposed = false;
  const renderer = {};
  const environment = createStudioEnvironment(THREE, renderer, RoomEnvironment);

  assert.equal(THREE.generator.renderer, renderer);
  assert.equal(THREE.generator.scene instanceof RoomEnvironment, true);
  assert.equal(THREE.generator.sigma, 0.04);
  assert.equal(THREE.roomDisposed, true);
  assert.equal(THREE.generatorDisposed, true);
  assert.equal(environment.texture, THREE.environmentTexture);
  environment.dispose();
  assert.equal(THREE.targetDisposed, true);
});

test('shared scene configuration preserves transparency and uses portrait lighting', () => {
  const environment = {};
  const scene = {
    environmentIntensity: 1,
    add(light) { this.lights ||= []; this.lights.push(light); },
  };
  const { keyLight } = configureAvatarScene(THREE, scene, { transparent: true, environment });

  assert.equal(scene.background, null);
  assert.equal(scene.environment, environment);
  assert.equal(scene.environmentIntensity, 0.7);
  assert.equal(scene.lights.length, 4);
  assert.deepEqual(keyLight.position, new Vector3(...AVATAR_VISUAL_CONFIG.scene.keyLight.position));
  assert.equal(keyLight.intensity, AVATAR_VISUAL_CONFIG.scene.keyLight.intensity);
  assert.equal(scene.lights[0].intensity, AVATAR_VISUAL_CONFIG.scene.hemisphere.intensity);
  assert.deepEqual(scene.lights[2].position, new Vector3(...AVATAR_VISUAL_CONFIG.scene.fillLight.position));
  assert.deepEqual(scene.lights[3].position, new Vector3(...AVATAR_VISUAL_CONFIG.scene.rimLight.position));

  const opaqueScene = { add() {} };
  configureAvatarScene(THREE, opaqueScene);
  assert.equal(opaqueScene.background.value, AVATAR_VISUAL_CONFIG.scene.background);
});

test('shared camera fit adapts distance to bounds and viewport aspect', () => {
  const bounds = {
    getCenter: (target) => target.set(0, 0.9, 0),
    getSize: (target) => target.set(2.4, 1.8, 0.5),
  };
  const landscape = fitAvatarCamera(THREE, bounds, 1.16);
  const portrait = fitAvatarCamera(THREE, bounds, 0.91);

  assert.deepEqual(landscape.center, new Vector3(0, 0.9, 0));
  assert.ok(portrait.distance > landscape.distance);
  assert.equal(fitAvatarCamera(THREE, bounds, 1.16, 2).distance, landscape.distance / 2);
  assert.throws(() => fitAvatarCamera(THREE, bounds, 0), /aspect and zoom/);
});

test('portrait mesh filtering keeps VRM glasses and facial meshes visible', () => {
  assert.equal(isAvatarPortraitMesh('glasses'), true);
  assert.equal(isAvatarPortraitMesh('AvatarHead / glasses'), true);
  assert.equal(isAvatarPortraitMesh('AvatarHead'), true);
  assert.equal(isAvatarPortraitMesh('outfit'), false);
});

test('portrait filtering preserves source visibility and restores the full model', () => {
  assert.equal(getAvatarMeshVisibility('glasses', true), true);
  assert.equal(getAvatarMeshVisibility('outfit', true), false);
  assert.equal(getAvatarMeshVisibility('outfit', false), true);
  assert.equal(getAvatarMeshVisibility('outfit', false, false), false);
  assert.equal(getAvatarMeshVisibility('outfit', true, true, false), true);
});

test('reference VRM exposes the morph targets the calibration relies on', async (t) => {
  const { readFile } = await import('node:fs/promises');
  let bytes;
  try {
    bytes = await readFile(new URL('./sarra7.vrm', import.meta.url));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return t.skip('Local reference VRM is not included in the repository.');
  }
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));

  const targets = (name) => {
    const node = document.nodes.find((entry) => entry.name === name);
    assert.ok(node, `missing node ${name}`);
    return document.meshes[node.mesh].primitives[0].extras?.targetNames || [];
  };
  assert.equal(targets('AvatarHead').length, 66);
  assert.equal(targets('AvatarEyelashes').length, 33);
  assert.equal(targets('AvatarTeethLower').length, 19);
  for (const morph of ['jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight', 'aa', 'PP', 'FF']) {
    assert.ok(targets('AvatarHead').includes(morph), `missing morph ${morph}`);
  }
});

test('at default zoom even near-plane-side corners of a portrait fit in narrow and wide viewports', () => {
  const box = { getCenter: (v) => v.set(0.12, 1.58, 0.04), getSize: (v) => v.set(0.24, 0.32, 0.23) };
  for (const aspect of [0.6, 0.91, 1, 1.7]) {
    const { center, distance } = fitAvatarCamera(THREE, box, aspect);
    const nearest = distance - 0.23 / 2;
    const halfHeight = nearest * Math.tan(AVATAR_VISUAL_CONFIG.camera.fov * Math.PI / 360);
    assert.ok(nearest > AVATAR_VISUAL_CONFIG.camera.near);
    assert.ok(halfHeight > 0.32 / 2);
    assert.ok(halfHeight * aspect > 0.24 / 2);
    assert.equal(center.x, 0.12, 'the face need not be centred on the origin');
  }
});
