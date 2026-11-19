# Sarra Avatar Core

Sarra Avatar Core is the renderer-independent facial engine used by SuperSarra.
The expression mixer and facial composer remain the single source of truth for
emotion, viseme, jaw, gaze, blink, transitions, priorities, and weight limits.
The package has no runtime dependency on Electron, Three.js, VRM, SuperSarra,
Studio, Gemini, or Ollama.

## Architecture

- `expression-mixer.js` composes the seven emotion profiles with the facial
  composer and coordinates the renderer adapter.
- `facial-composer.js` owns viseme, jaw, gaze, blink, transition, and facial
  priority rules.
- `adapters/vrm.js` maps composed weights to a loaded VRM's morph targets and
  normalized eye bones. Bindings and eye bones are indexed once per model,
  not rediscovered each frame. It has no Three.js import; the application owns loading,
  rendering, model disposal, and GPU resources.
- `calibration-profile.js` is the single calibration schema: it owns versioned
  profiles, compatibility checks, JSON parsing, and the bounded emotion,
  viseme, jaw, and transition settings. `studio.js` re-exports profile helpers
  and keeps scenarios, capture, analysis, and calibration proposals separate.
- `visual-config.js` is an optional renderer integration helper, not part of
  the facial Core. It has no Three.js dependency: hosts pass their Three.js
  namespace to share color management, lighting, renderer settings, camera
  framing, and portrait-accessory visibility.
- `index.js` is the package's public entry point.

The adapter contract is renderer-neutral: optionally implement `loadAvatar`,
`isLoaded`, `getAvailableExpressionTargets`, `getModelIdentity`,
`setModelIdentity`, `getGazeCapabilities`, `getBlinkCapabilities`,
`applyGaze`, `applyMorphWeights`, `clearMorphWeights`, and `dispose`.
The engine can use a different rendering stack by supplying another adapter;
facial calculations do not move into that adapter.

## Dependencies

The Core package has **no runtime dependencies** and requires Node.js 20+ for
tests and tooling. Browser hosts can import its ES modules directly.

Only the standalone demonstration depends on Three.js `0.169.0`,
`@pixiv/three-vrm` `3.3.3`, and Vite. Those are application/rendering
dependencies, not Core dependencies.

SuperSarra's browser import map uses the same Three.js and three-vrm versions.
Both renderer hosts use the optional visual configuration without making the
Core depend on Electron, Three.js, or a particular rendering application.

## Shared visual configuration

The demo and SuperSarra inject their renderer's Three.js namespace into the
same optional integration helpers:

```js
import {
  configureAvatarScene,
  createAvatarRenderer,
  createStudioEnvironment,
  fitAvatarCamera,
} from '@sarra/avatar-core/visual-config';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const renderer = createAvatarRenderer(THREE, canvas, {
  alpha: true, // keep an Electron overlay transparent
  pixelRatio: window.devicePixelRatio || 1,
});
const environment = createStudioEnvironment(THREE, renderer, RoomEnvironment);
configureAvatarScene(THREE, scene, {
  transparent: true,
  environment: environment.texture,
});
window.addEventListener('beforeunload', () => environment.dispose(), { once: true });

const { center, distance } = fitAvatarCamera(THREE, avatarBounds, camera.aspect);
camera.position.set(center.x, center.y, center.z + distance);
controls.target.copy(center);
```

The shared setup pins sRGB output, uses AgX tone mapping, prefilters a neutral
studio environment for image-based lighting, and combines it with a balanced
hemisphere/key/fill/rim portrait-lighting rig. HiDPI rendering is capped at
2.5× to improve fine detail without unbounded GPU cost; shadows remain disabled
for the transparent overlay. The neutral environment adds soft reflected light
and material highlights while the directional lights preserve facial shape.
Dispose the returned environment target when the renderer is torn down. An
opaque host retains the demo background; a transparent host keeps its
transparent canvas. `isAvatarPortraitMesh()` also
keeps the VRM's named `glasses` mesh visible when an app uses portrait-only
rendering. `getAvatarMeshVisibility()` combines that filter with each mesh's
original visibility so switching back to the full-avatar view restores the
model without overriding meshes that were hidden in the source.

## Public API

```js
import { createAvatarCore } from '@sarra/avatar-core';

const core = createAvatarCore({ adapter });
await core.loadAvatar(loadedVrm, { modelIdentity });
core.setEmotion('joie', 1, 420);   // intensity 0..1.5, duration in ms
core.setViseme('AA', 1, 80);      // aliases A/I/U/E/O are accepted
core.setJawOpen(0.35);
core.setGaze(0.2, -0.1);          // normalized coordinates, clamped to -1..1
core.setBlink(1);                 // optional side: 'both', 'left', or 'right'
core.resetExpression(420);        // transition the emotion layer to neutral
core.update(deltaSeconds);        // call once per frame; delta is seconds
const calibration = core.exportCalibration();
const saved = core.exportCalibrationProfile();
core.applyCalibration(saved.profile);
core.dispose();
```

## Snapshot and capture convergence

Studio hosts can read `core.getSnapshot()` for the active emotions and viseme,
jaw, gaze, blink, composed weights, adapter-applied weights, autonomous motion
state, timestamp, and frame. The returned objects are frozen copies; they never
expose internal mutable state.

`core.getConvergence()` distinguishes mixer convergence, composer convergence,
morph application and stability, rendered stability, and final capture
permission. The host must call `core.markFrameRendered()` after rendering each
frame and wait for `snapshot.convergence.captureAllowed` plus its independent
pixel-stability checks before accepting a Studio capture.

`core.freezeSecondaryMotion()` temporarily disables automatic blinking and
natural gaze. `core.restoreSecondaryMotion()` guarantees restoration of their
previous state. Studio may also import `waitForCoreConvergence` from
`studio.js`; it accepts only the explicit Core convergence contract and reports
a timeout instead of inferring success from a fixed delay.

`loadAvatar()` delegates to the injected adapter; an adapter that does not
implement loading reports `avatar-loader-not-configured`. `setViseme` accepts
an optional transition duration in milliseconds. Use `resetBehavior()` when
the application wants to stop all facial behaviors (including lipsync, gaze,
and blinking); `resetExpression()` only resets the emotion layer, so a host can
neutralize emotion without interrupting active speech.

`exportCalibration()` preserves its original `{ ok, parameters, transitions,
mappings }` shape. Once a loaded adapter provides a complete model identity, it
also includes the compatible versioned profile fields. Use
`exportCalibrationProfile({ results })` to request an explicit
`{ ok, profile }` result with model identity, schema, Core version, and optional
Studio results. `applyCalibration()` continues to accept the original partial
calibration object. A versioned profile must match schema version 1, Core
version `0.4.0`, model ID, fingerprint, and rig signature. It is fully
validated before the active calibration changes. Phase 5 `legacyVisemes`
mappings are accepted and normalized into the Core viseme mapping.

`dispose()` is idempotent, clears Core-applied morph weights, restores the
adapter's gaze offsets, and releases its adapter reference. It does not dispose
the application's VRM, renderer, or GPU resources.

## External VRM integration

The host loads VRM with its own `GLTFLoader` and
`@pixiv/three-vrm` dependency, then hands the VRM object to the lightweight
adapter. Model identity is application-owned; use a SHA-256 digest of the
original VRM bytes and a stable rig signature.

```js
import { createAvatarCore, createVrmAdapter } from '@sarra/avatar-core';

const adapter = createVrmAdapter();
const core = createAvatarCore({ adapter });
const gltf = await gltfLoader.parseAsync(await file.arrayBuffer(), '');
const vrm = gltf.userData.vrm;
const modelIdentity = {
  id: file.name,
  fingerprint: sha256Hex,
  rigSignature: JSON.stringify(sortedMorphTargetNames),
};

await core.loadAvatar(vrm, { modelIdentity });
core.setVisemeMapping({ AA: { aa: 1 }, IH: { ih: 1 } });
core.setAutoBlink(core.getBlinkCapabilities().left);
core.setEmotion('joie', 1, 420);

function frame(deltaSeconds) {
  vrm.update(deltaSeconds);
  core.update(deltaSeconds);
  renderer.render(scene, camera);
}
```

For lipsync, call `setViseme(viseme, intensity, duration)` as the host's speech
recognizer or TTS produces viseme events. The composer interpolates these
contributions with emotion, jaw, gaze, and blinking while preserving the
existing mouth-priority and weight-clamping rules. Stop speech with
`core.resetViseme()`; the Core does not depend on or process audio.

## Calibration persistence

```js
import { parseCalibrationProfileJSON } from '@sarra/avatar-core';

const { profile } = core.exportCalibrationProfile();
localStorage.setItem('avatar-calibration', JSON.stringify(profile));

const parsed = parseCalibrationProfileJSON(
  localStorage.getItem('avatar-calibration'),
  core.getModelIdentity(),
);
if (!parsed.ok) throw new Error(parsed.validation?.reasons.join(', ') || parsed.error);
const applied = core.applyCalibration(parsed.profile);
if (!applied.ok) throw new Error(applied.reasons?.join(', ') || applied.error);
```

Use the same model identity after reload. Schema, version, model, rig, mappings,
parameters, and transitions are validated before any active value is changed.
Emotion and lipsync scales are bounded to 80–120%; the Sarra Studio exposes
these settings in one calibration panel. An incompatible profile returns an
error and leaves the current calibration untouched.

## Standalone demonstration

The demo is a regular browser app with no Electron, SuperSarra, Studio, Gemini,
or Ollama. From the repository root:

```text
npm --prefix demo ci
npm run demo
```

Open the printed local URL and choose **Importer un VRM** to load a local
model. VRM files are not included in this repository; use a model you are
authorized to use.
The app demonstrates emotion and viseme controls, jaw, gaze, blinking, local
profile persistence, JSON import/export, and model/profile compatibility. Its
voice and ambient mic controls use the shared `../audio/` browser pipeline;
only the host acquires devices, never the Core.
Your browser retains the saved calibration across page reloads.

## SuperSarra compatibility and validation

SuperSarra imports the same `@sarra/avatar-core` source modules and its
`window.SarraEmotion` compatibility facade remains in place. The Electron main
and preload processes do not import the Core. The Studio keeps its UI and
scenario machinery outside the Core package and uses the shared profile
validator.

Run the existing and Core test suites from the repository root with
`npm test`. The VRM adapter tests use a renderer-free fixture; the demo can be
built with `npm run demo:build` at the root. After installing demo dependencies,
`npm --prefix demo test` checks portrait projection using real Three.js geometry.
