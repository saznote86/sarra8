import {
  AgXToneMapping, Box3, Clock, Color, DirectionalLight, HemisphereLight, MathUtils,
  PMREMGenerator, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { createAvatarCore, createVrmAdapter, EMOTION_PROFILES, parseCalibrationProfileJSON } from '@sarra/avatar-core';
import { AVATAR_VISUAL_CONFIG, configureAvatarScene, createAvatarRenderer, createStudioEnvironment, fitAvatarCamera, measureAvatarViews } from '@sarra/avatar-core/visual-config';
import { applyDefaultAvatarAppearance } from '@sarra/avatar-core/appearance';
import { detectVrmVisemes, restoreVrmMorphNames } from '@sarra/avatar-core/vrm-rig';
import { mountAudioPanel } from './audio-panel.js';

// Pass only the constructors used by the renderer-neutral helpers so Rollup
// never has to keep the entire Three.js namespace in the download.
const graphics = { AgXToneMapping, Box3, Color, DirectionalLight, HemisphereLight, MathUtils, PMREMGenerator, SRGBColorSpace, Vector3, WebGLRenderer };
const $ = (selector) => document.querySelector(selector);
const all = (selector) => document.querySelectorAll(selector);
const canvas = $('#view');
const calibrationKey = 'sarra.avatar-core.demo.calibration.v1';
const { fov, near, far } = AVATAR_VISUAL_CONFIG.camera;
const scene = new Scene();
const camera = new PerspectiveCamera(fov, 1, near, far);
const renderer = createAvatarRenderer(graphics, canvas, { alpha: true, pixelRatio: window.devicePixelRatio || 1 });
const environment = createStudioEnvironment(graphics, renderer, RoomEnvironment);
configureAvatarScene(graphics, scene, { transparent: true, environment: environment.texture });
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
let active = null;
let sequence = 0;
let view = 'portrait';
const audio = mountAudioPanel({
  getAvatar: () => active,
  onMouthMode(busy) {
    if (!active) return;
    if (busy) { active.core.resetViseme(80); select('viseme', null); }
    syncCapabilities();
  },
});

function announce(text, state = 'ready') {
  $('#status').textContent = text;
  document.body.dataset.state = state;
}
function reportError(error) { announce(`Erreur : ${error.message || error}`, 'error'); }
function select(group, value) {
  for (const button of all(`[data-${group}]`)) button.setAttribute('aria-pressed', String(button.dataset[group] === value));
}
function reframe() {
  if (!active) return;
  const bounds = active.views[view === 'detail' ? 'portrait' : view];
  const { center, distance } = fitAvatarCamera(graphics, bounds, camera.aspect, view === 'detail' ? 1.28 : 1);
  if (view === 'detail') center.y += (bounds.max.y - bounds.min.y) * 0.07;
  controls.target.copy(center);
  camera.position.set(center.x, center.y, center.z + distance);
  controls.minDistance = Math.max(near * 1.1, distance * 0.35);
  controls.maxDistance = Math.max(distance * 4, 2);
  controls.update();
}
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  reframe();
}
const observer = new ResizeObserver(resize);
observer.observe(canvas);
resize();

function resetPose() {
  const { core } = active;
  core.resetBehavior();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const { left, right } = core.getBlinkCapabilities();
  core.setAutoBlink(!reduced && (left || right));
  core.setNaturalGaze(!reduced && core.hasGazeControl());
  for (const id of ['jaw', 'gaze-x', 'gaze-y', 'blink']) $(`#${id}`).value = 0;
  select('emotion', 'neutre'); select('viseme', null);
}

function syncCapabilities() {
  const { core, targets, model } = active;
  for (const button of all('[data-emotion]')) {
    const name = button.dataset.emotion;
    button.disabled = name !== 'neutre' && !Object.keys(EMOTION_PROFILES[name]).some((target) => targets.has(target));
  }
  const mapping = core.exportCalibration().mappings.visemes;
  for (const button of all('[data-viseme]')) {
    button.disabled = audio.ownsMouth || !Object.keys(mapping[button.dataset.viseme] || {}).some((target) => targets.has(target));
  }
  $('#stop-speech').disabled = audio.ownsMouth;
  $('#jaw').disabled = audio.ownsMouth || !targets.has('jawOpen');
  $('#gaze-x').disabled = $('#gaze-y').disabled = !core.hasGazeControl();
  const blink = core.getBlinkCapabilities();
  $('#blink').disabled = !blink.left && !blink.right;
  for (const id of ['save-profile', 'load-profile', 'export-profile', 'choose-profile']) $(`#${id}`).disabled = !model.fingerprint;
}

function releaseActive() {
  if (!active) return;
  active.core.dispose();
  scene.remove(active.vrm.scene);
  VRMUtils.deepDispose(active.vrm.scene);
  active = null;
}

// Prepare the candidate independently: a slow or invalid import must not
// replace the newer avatar, discard its calibration, or leak a parsed scene.
async function loadAvatar(name, readBuffer, bundled = false) {
  const id = ++sequence;
  let gltf = null, core = null;
  audio.enable(false);
  $('#rig-controls').disabled = true;
  announce(`Chargement de ${name}…`, 'loading');
  try {
    const bytes = await readBuffer();
    if (id !== sequence) return;
    const digest = globalThis.crypto?.subtle ? await crypto.subtle.digest('SHA-256', bytes) : null;
    if (id !== sequence) return;
    const fingerprint = digest ? Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('') : '';
    gltf = await loader.parseAsync(bytes, '');
    if (id !== sequence) return;
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('Ce fichier ne contient pas d’avatar VRM.');
    restoreVrmMorphNames(gltf);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((node) => { if (node.isMesh) node.frustumCulled = false; });
    if (bundled) {
      applyDefaultAvatarAppearance(vrm);
      // Match the relaxed arm pose of the desktop avatar, not a T-pose.
      for (const [bone, angle] of [['leftUpperArm', 1.1], ['rightUpperArm', -1.1]]) {
        const arm = vrm.humanoid.getNormalizedBoneNode(bone);
        if (arm) arm.rotation.z = angle;
      }
      vrm.update(0);
    }
    const views = measureAvatarViews(graphics, vrm);
    const adapter = createVrmAdapter();
    core = createAvatarCore({ adapter });
    const result = await core.loadAvatar(vrm, { modelIdentity: { id: name } });
    if (!result.ok) throw new Error(result.error);
    if (id !== sequence) return;
    const targets = new Set(adapter.getAvailableExpressionTargets().morphTargets);
    core.setVisemeMapping(detectVrmVisemes(targets));
    const rigSignature = JSON.stringify({ targets: [...targets].sort(), gaze: core.getGazeCapabilities(), blink: core.getBlinkCapabilities() });
    const model = { id: name, fingerprint, rigSignature };
    core.setModelIdentity(model);
    releaseActive();
    active = { vrm, core, model, targets, views };
    core = gltf = null; // Ownership transferred to active.
    scene.add(vrm.scene);
    // The supplied file's active glTF scene is a bust: its body/outfit nodes
    // are not attached. Offer a real close-up, not two identical views.
    const hasBody = (views.body.max.y - views.body.min.y) > (views.portrait.max.y - views.portrait.min.y) * 1.3;
    const alternate = $('#alternate-view');
    alternate.dataset.view = hasBody ? 'body' : 'detail';
    alternate.textContent = hasBody ? 'Corps entier' : 'Gros plan';
    view = 'portrait'; select('view', view);
    resetPose(); syncCapabilities(); reframe(); startRendering();
    $('#joy-scale').value = 1;
    $('#model-name').textContent = bundled ? 'Sarra' : name.replace(/\.vrm$/i, '') || name;
    $('#rig-count').textContent = `${targets.size} cibles`;
    $('#placeholder').hidden = true;
    $('#reframe').disabled = false;
    for (const button of all('[data-view]')) button.disabled = false;
    announce(`${name} chargé · ${fingerprint ? `SHA-256 ${fingerprint.slice(0, 12)}…` : 'Profils désactivés : ouvrez la démo sur localhost ou en HTTPS.'}`);
  } catch (error) {
    if (id === sequence) {
      if (!active) $('#placeholder').textContent = 'Importez un fichier VRM pour commencer.';
      reportError(error);
    }
  } finally {
    core?.dispose();
    if (gltf?.scene) VRMUtils.deepDispose(gltf.scene);
    if (id === sequence) { $('#rig-controls').disabled = !active; audio.enable(!!active); }
  }
}

$('#choose-avatar').disabled = false;
$('#choose-avatar').onclick = () => $('#avatar-file').click();
$('#avatar-file').onchange = ({ target }) => {
  const file = target.files[0]; target.value = '';
  if (file) loadAvatar(file.name, () => file.arrayBuffer());
};
for (const button of all('[data-emotion], [data-viseme]')) {
  button.onclick = () => {
    const emotion = button.dataset.emotion;
    const result = emotion ? active.core.setEmotion(emotion, 1, 420) : active.core.setViseme(button.dataset.viseme, 1, 120);
    if (!result.ok) return reportError(result.error);
    select(emotion ? 'emotion' : 'viseme', emotion || button.dataset.viseme);
    announce(`${emotion ? 'Expression' : 'Articulation'} : ${button.textContent}.`);
  };
}
for (const button of all('[data-view]')) button.onclick = () => { view = button.dataset.view; select('view', view); reframe(); };
$('#reframe').onclick = reframe;
$('#stop-speech').onclick = () => { active.core.resetViseme(160); select('viseme', null); announce('Lèvres relâchées.'); };
$('#reset').onclick = () => { audio.stopAll(); resetPose(); announce('Visage réinitialisé.'); };
$('#jaw').oninput = (e) => active.core.setJawOpen(Number(e.target.value));
$('#blink').oninput = (e) => active.core.setBlink(Number(e.target.value));
$('#gaze-x').oninput = $('#gaze-y').oninput = () => active.core.setGaze(Number($('#gaze-x').value), Number($('#gaze-y').value));
$('#joy-scale').oninput = (e) => {
  const result = active.core.applyCalibration({ emotionScales: { joie: Number(e.target.value) } });
  if (!result.ok) reportError(result.error);
};

function exportProfile() {
  const result = active.core.exportCalibrationProfile();
  if (!result.ok) throw new Error(result.error);
  return JSON.stringify(result.profile, null, 2);
}
function importProfile(json) {
  const result = parseCalibrationProfileJSON(json, active.model);
  if (!result.ok) throw new Error(`Profil refusé : ${result.validation?.reasons?.join(', ') || result.error}`);
  const applied = active.core.applyCalibration(result.profile);
  if (!applied.ok) throw new Error(`Profil refusé : ${applied.error}`);
  $('#joy-scale').value = result.profile.parameters.emotionScales?.joie ?? 1;
  syncCapabilities();
  announce('Profil compatible appliqué.');
}
$('#save-profile').onclick = () => {
  try { localStorage.setItem(calibrationKey, exportProfile()); announce('Profil enregistré dans ce navigateur.'); }
  catch (e) { reportError(e); }
};
$('#load-profile').onclick = () => {
  try { const json = localStorage.getItem(calibrationKey); if (!json) throw new Error('Aucun profil local enregistré.'); importProfile(json); }
  catch (e) { reportError(e); }
};
$('#export-profile').onclick = () => {
  try {
    const url = URL.createObjectURL(new Blob([exportProfile()], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `sarra-calibration-${active.model.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('Profil exporté en JSON.');
  } catch (e) { reportError(e); }
};
$('#choose-profile').onclick = () => $('#profile-file').click();
$('#profile-file').onchange = async ({ target }) => {
  const file = target.files[0]; target.value = ''; if (!file) return;
  try { if (file.size > 1_000_000) throw new Error('Profil trop volumineux (1 Mo maximum).'); importProfile(await file.text()); }
  catch (e) { reportError(e); }
};

const clock = new Clock(false);
let frame = 0;
function render() {
  const dt = Math.min(clock.getDelta(), 0.05);
  active.core.clearMorphWeights(); // Undo our last layer BEFORE the VRM writes its own weights.
  audio.applyFrame(dt, performance.now());
  active.vrm.update(dt);
  active.core.update(dt);
  controls.update(); renderer.render(scene, camera); active.core.markFrameRendered();
  frame = requestAnimationFrame(render);
}
function startRendering() {
  if (!active || frame || document.hidden) return;
  clock.start(); frame = requestAnimationFrame(render);
}
function stopRendering() { cancelAnimationFrame(frame); frame = 0; clock.stop(); }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { audio.stopAll(); stopRendering(); } else startRendering();
});
window.addEventListener('pagehide', (event) => {
  audio.stopAll(); stopRendering();
  if (!event.persisted) { audio.dispose(); sequence++; releaseActive(); observer.disconnect(); controls.dispose(); environment.dispose(); renderer.dispose(); }
});
window.addEventListener('pageshow', startRendering);
$('#placeholder').textContent = 'Importez un fichier VRM pour commencer.';
announce('Prêt · importez un avatar VRM.');
