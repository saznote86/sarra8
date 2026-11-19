'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

test('desktop settings keep one panel and include facial and lipsync calibration', () => {
  const shell = read('shell.html');
  const panel = read('settings-panel.html');
  const calibration = read('settings-calibration.js');

  assert.match(shell, /aria-current="page">Configuration/);
  assert.doesNotMatch(shell, /Panneau Sarra Studio|tab-app|sarra-switch-tab|frameUrl\('settings'\)/);
  assert.doesNotMatch(panel, /open-studio|Panneau Sarra Studio/);
  assert.match(panel, /id="calibration-card"/);
  assert.match(panel, /Visèmes, émotions &amp; lipsync/);
  assert.match(calibration, /PROFILE_EMOTION_NAMES/);
  assert.match(calibration, /PROFILE_VISEME_NAMES/);
  assert.match(calibration, /transitions\.visemeScale/);
  assert.match(calibration, /'apply-profile'/);
});

test('le panneau expose le lipsync naturel et diffuse les réglages en direct', () => {
  const panel = read('settings-panel.html');
  const lipsync = read('settings-lipsync.js');
  const app = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');

  assert.match(panel, /id="natural-lipsync-card"/);
  assert.match(panel, /Lipsync naturel/);
  assert.match(panel, /id="natural-lipsync-groups"/);
  assert.match(panel, /id="natural-test"/);
  assert.match(panel, /id="natural-reset"/);
  assert.match(panel, /id="natural-save"/);
  assert.match(panel, /settings-lipsync\.js/);

  assert.match(lipsync, /LIPSYNC_DYNAMIC_KEYS/);
  assert.match(lipsync, /NATURAL_LIPSYNC_DEFAULTS/);
  assert.match(lipsync, /'lipcfg'/);
  assert.match(lipsync, /'lipdef'/);
  assert.match(lipsync, /type: 'lipcfg'/);
  assert.match(lipsync, /type: 'speak'/);
  assert.match(lipsync, /addEventListener\('storage'/);
  for (const key of ['coart', 'atk', 'rel', 'hold', 'idle', 'jit', 'clos', 'fv', 'jawG', 'jawLag', 'cps', 'lat', 'rate', 'antic', 'consonantLead', 'textMix']) {
    assert.match(lipsync, new RegExp(`key: '${key}'`));
  }

  assert.match(app, /d\.type==='lipcfg'/);
  assert.match(app, /LIPSYNC_DYNAMIC_KEYS/);
  assert.match(app, /advanceVisemeCursor/);
  assert.match(app, /sampleVisemeTargets/);
});

test('le panneau de configuration propose le mode clair / sombre synchronisé', () => {
  const panel = read('settings-panel.html');
  const shell = read('shell.html');
  const app = fs.readFileSync(path.join(__dirname, '..', 'Sarra — avatar VRM & lipsync avancé.html'), 'utf8');

  assert.match(panel, /id="theme-toggle"/);
  assert.match(panel, /Mode clair/);
  assert.match(panel, /:root\[data-theme="light"\]/);
  assert.match(panel, /const THEME_LS = 'sarra\.theme'/);
  assert.match(panel, /localStorage\.getItem\(THEME_LS\)/);
  assert.match(panel, /addEventListener\('storage'/);
  assert.match(panel, /bus\.postMessage\(\{ type: 'theme', mode: resolved \}\)/);

  assert.match(shell, /:root\[data-theme="light"\]/);
  assert.match(shell, /function applyShellTheme/);
  assert.match(shell, /addEventListener\('storage'/);

  assert.match(app, /options\.broadcast!==false && bus/);
  assert.match(app, /d\.type==='theme'/);
  assert.match(app, /addEventListener\('storage'/);
});
