import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fitAvatarCamera, measureAvatarViews } from '@sarra/avatar-core/visual-config';

function part(scene, name, size, center, visible = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.name = name; mesh.position.set(...center); mesh.visible = visible; scene.add(mesh);
  return mesh;
}
function rig() {
  const scene = new THREE.Scene();
  const head = new THREE.Object3D(); head.position.set(0.3, 1.55, -0.2); scene.add(head);
  return { scene, humanoid: { getNormalizedBoneNode: (name) => name === 'head' ? head : null } };
}

test('portrait measures real face geometry; visibility is reversible and all eight corners fit', () => {
  const vrm = rig();
  const body = part(vrm.scene, 'Outfit', [1.2, 1.5, 0.3], [0.3, 0.75, -0.2]);
  const face = part(vrm.scene, 'AvatarHead', [0.22, 0.33, 0.24], [0.3, 1.59, -0.19]);
  const glasses = part(vrm.scene, 'glasses', [0.27, 0.06, 0.05], [0.3, 1.62, -0.035]);
  const hidden = part(vrm.scene, 'hair', [1, 1, 1], [0, 0, 0], false);
  const views = measureAvatarViews(THREE, vrm);
  assert.ok(views.portrait.min.y > 1.4);
  assert.ok(views.portrait.max.z >= -0.011, 'the glasses contribute to the fit');
  views.setPortraitOnly(true);
  assert.ok(face.visible && glasses.visible && !body.visible && !hidden.visible);
  views.setPortraitOnly(false);
  assert.ok(body.visible && !hidden.visible);
  for (const aspect of [0.6, 1, 1.8]) {
    const { center, distance } = fitAvatarCamera(THREE, views.portrait, aspect);
    const camera = new THREE.PerspectiveCamera(32, aspect, 0.1, 100);
    camera.position.copy(center); camera.position.z += distance; camera.lookAt(center); camera.updateMatrixWorld();
    const { min, max } = views.portrait;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      const p = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.z) <= 1);
    }
  }
});

test('an undivided body with tiny named eyes falls back to the head bone without hiding the body', () => {
  const vrm = rig();
  const body = part(vrm.scene, 'Combined', [0.8, 1.8, 0.3], [0.3, 0.9, -0.2]);
  part(vrm.scene, 'LeftEye', [0.03, 0.03, 0.03], [0.33, 1.61, -0.05]);
  const views = measureAvatarViews(THREE, vrm);
  assert.ok(views.portrait.min.y > 1 && views.portrait.max.y > 1.7);
  assert.ok(views.portrait.containsPoint(new THREE.Vector3(0.3, 1.55, -0.2)));
  views.setPortraitOnly(true); assert.ok(body.visible);
});

test('an unnamed bust without a head bone remains in frame', () => {
  const scene = new THREE.Scene();
  const mesh = part(scene, 'Mesh_0', [0.2, 0.31, 0.25], [0.5, 1.6, -0.5]);
  const views = measureAvatarViews(THREE, { scene });
  assert.ok(views.portrait.equals(views.body));
  views.setPortraitOnly(true); assert.ok(mesh.visible);
});
