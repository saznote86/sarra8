# Coque desktop Sarra — UI avancée, persistance et IA

Ce document décrit l'implémentation des cinq évolutions demandées pour la coque
Electron : fenêtre avatar (transparence + click-through), micro / drag / resize,
raccourcis, persistance `state.json` avec directives et mémoire, onboarding.

## 1. État du dépôt au moment de l'implémentation

Le snapshot public `dvdexpresstunisia/Sarra8` contient `desktop/README.md`,
`desktop/live.test.js`, `desktop/avatar-appearance.mjs` — mais **pas**
`desktop/main.js`, `desktop/preload.js`, `desktop/shell.html`, `desktop/package.json`
ni `desktop/state.json`, alors que le README, les tests et l'application web les
référencent.

Les fichiers absents ont donc été **écrits** en respectant strictement les
contrats déjà présents dans le dépôt :

| Contrat existant | Source | Respecté par |
|---|---|---|
| `window.sarraDesktop` (`voices`, `speak`, `onTtsEvent`, `generateResponse`, `testApiKey`, `dragStart/Move/End`, `resizeAvatar`, `toggleSettings`, `settingsDragStart/Move/End`, `resizeSettings`, `showMenu`, `openExternal`, `ttsAudio`) | `Sarra — avatar VRM & lipsync avancé.html` | `desktop/preload.js` |
| `?shell=avatar` / `?shell=settings` dans une iframe | idem (lignes 279-300) | `desktop/shell.html` |
| `postMessage({type:'sarra-startup', state})` | idem (`notifyStartup`) | `desktop/shell.html` |
| `@keyframes startup-progress`, `data.state === 'complete' / 'error'` | `desktop/live.test.js` | `desktop/shell.html` |
| Hôte vocal Python/Qt sur `127.0.0.1:8649`, JSON par ligne, événements `start`/`boundary`/`end` | `desktop/README.md` | `desktop/lib/tts-bridge.js` |
| `liveStart` / `liveStop` / `liveAudio` / `liveAudioEnd` / `liveToolResponse` / `onLiveEvent` | `Sarra — avatar ….html`, `desktop/live.js` | `desktop/main.js` + `desktop/preload.js` |
| `desktop/launch.vbs` + `start.bat` silencieux | `desktop/live.test.js` | ajoutés |
| `desktop/state.json` pour la mémoire des fenêtres | `desktop/README.md` | `desktop/lib/state-store.js` |

Trois fichiers existants sont touchés, de façon strictement additive :

* `Sarra — avatar VRM & lipsync avancé.html` : un bloc isolé « modèle par
  défaut » (16 lignes, avant le hook `DESKTOP.onVrmLoad`) qui `fetch`
  `sarra7.vrm` / `sarra7c.vrm` et rend compte via `notifyStartup(...)` — c'est
  ce qu'exige `desktop/live.test.js` et cela rend l'app utilisable sans import
  manuel ;
* `start.bat` : nouveau point d'entrée `start.bat desktop` (lance la coque via
  `wscript.exe //NoLogo desktop\launch.vbs`) ; le comportement par défaut
  (atelier web) est inchangé ;
* `desktop/README.md` : section ajoutée en fin de fichier.

Le moteur VRM, le lipsync et `desktop/live.js` ne sont **pas** modifiés.

## 2. Architecture

```
desktop/main.js        processus principal
 ├─ serveur HTTP 127.0.0.1:<port éphémère>   (modules ES + fetch du .vrm)
 ├─ fenêtre avatar     shell.html?mode=avatar    → iframe ?shell=avatar
 ├─ fenêtre réglages   shell.html?mode=settings  → onglet natif + iframe ?shell=settings
 ├─ desktop/state.json (identité, clé, directives, historique, fenêtres)
 └─ lib/tts-bridge.js  ↔ 127.0.0.1:8649 (tts_host.py PyQt6)
```

Le serveur local est indispensable : l'application charge des modules ES
(`./audio/browser.js`, `./avatar-core/…`) et fait `fetch('sarra7.vrm')`, ce que
`file://` interdit. `state.json` et les journaux ne sont **jamais** servis
(liste de refus dans `main.js`).

## 3. Correspondance tâches → code

### Tâche 1 — fenêtre avatar + click-through (`desktop/main.js`)

```js
avatarWindow = new BrowserWindow({
  transparent: true,
  frame: false,
  alwaysOnTop: true,
  resizable: false,      // redim. manuel (molette/bords)
  movable: false,        // drag piloté par l'app
  skipTaskbar: true,
  backgroundColor: '#00000000',
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false }
});
avatarWindow.setAlwaysOnTop(true, 'screen-saver');
avatarWindow.setIgnoreMouseEvents(true, { forward: true }); // au démarrage
```

* canal IPC demandé : `set-ignore-mouse-events` (écouté dans `registerIpc()`),
  relayé côté renderer par `sarradesktop.setIgnoreMouseEvents(bool)` ;
* le premier plan est réappliqué sur `show` et `focus` (exigence du README) ;
* `avatarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`.

**Trois mécanismes complémentaires** rendent le click-through fiable :

1. **IPC** — le renderer force l'état (`set-ignore-mouse-events`) ;
2. **survol same-origin** — `shell.html` et l'iframe sont servis par le même
   serveur, donc la coque écoute directement `mouseenter`/`mouseleave` du
   document de l'iframe et bascule l'état (exigence « survol de l'avatar ») ;
3. **test de position du curseur** (`startHitTestWatcher`, 70 ms) — filet de
   sécurité : `forward: true` n'existe que sous Windows, et l'iframe absorbe les
   pointer events. Le main compare `screen.getCursorScreenPoint()` aux `bounds`
   de la fenêtre et applique l'état correspondant.

`Ctrl+Shift+L` verrouille/déverrouille le mode interactif (utile si le curseur
reste piégé au-dessus de l'avatar).

### Tâche 2 — micro, drag, resize (`desktop/shell.html` + IPC)

* **Bouton micro** : il est rendu par l'application elle-même
  (`#voice-assistant`, positionné en bas au centre par le CSS `?shell=avatar`
  de l'app). La coque garantit qu'il est cliquable (click-through désactivé au
  survol) et n'ajoute aucun doublon visuel.
* **Déplacement** : `cv.pointerdown` → `sarradesktop.dragStart({x,y})` (déjà
  dans l'app) → `avatar:drag-start|move|end` → `setPosition`, puis sauvegarde de
  `avatar.x/y` dans `state.json`.
* **Molette** : `shell.html` attache un listener `wheel` sur le document de
  l'iframe → `sarradesktop.resizeAvatar({deltaY})` → `avatarWindow.setSize`
  (160–900 px de large).
* **Bords / coins** : huit surcouches `.edge` (6 px) au-dessus de l'iframe,
  ancrage du bord opposé (`avatar:resize` accepte `x`/`y`).

### Tâche 3 — UI et raccourcis (`desktop/main.js`)

* fenêtre réglages créée avec `show: false` ; fermer = `hide()` ;
* `globalShortcut.register('CommandOrControl+Shift+K', () => toggleSettingsWindow())`
  enregistré dans `app.whenReady()` et libéré dans `will-quit` ;
* raccourcis complémentaires : `Ctrl+Shift+L` (mode interactif),
  `Ctrl+Shift+Q` (quitter) ; un échec d'enregistrement est journalisé, jamais fatal.

### Tâche 4 — persistance, mémoire, core directives

`desktop/state.json` (valeurs par défaut écrites par `desktop/lib/state-store.js`) :

```json
{
  "onboardingCompleted": false,
  "avatarName": "Sarra",
  "userName": "",
  "geminiApiKey": "",
  "coreDirectives": "Tu es Sarra…",
  "chatHistory": [{ "role": "user", "text": "…", "ts": 1763000000000 }],
  "engines": { "reasoning": "gemini", "voice": "gemini", "model": "gemini-2.5-flash",
               "temperature": 0.85, "contextExchanges": 10 },
  "avatar": { "x": null, "y": null, "width": 320, "height": 352, "opacity": 1 },
  "tts": { "host": "127.0.0.1", "port": 8649, "hostScript": "desktop/tts/tts_host.py" }
}
```

* écriture **atomique** (`tmp` + `rename`), sérialisée, avec repli sur
  `app.getPath('userData')` si le dossier est en lecture seule (asar) ;
* fichier corrompu → sauvegardé en `state.json.corrupt-<timestamp>` puis
  remplacé par les défauts ;
* mémoire bornée à 400 messages (200 échanges) ;
* `PATCHABLE_*` dans `main.js` : le renderer ne peut écrire que des champs
  connus (pas de pollution de `state.json`).

**Injection dans Gemini** (`desktop/lib/gemini.js`) :

```
systemInstruction = identité (avatarName / userName)
                  + règles de forme (réponse orale courte, pas de markdown)
                  + règles de mémoire (ne pas réciter l'historique)
                  + « Directives de base » (coreDirectives ou directives du panneau)
                  + consigne de confidentialité
contents          = les 10 derniers échanges de chatHistory
                  + le message courant
```

`buildContents()` garantit les contraintes de l'API : premier tour `user`,
alternance `user`/`model`, fusion des tours consécutifs de même rôle, et
suppression du doublon quand le même message est rejoué (retry).

Dans l'interface : nouvel onglet **« Identité, IA & directives »** de la fenêtre
Réglages (`desktop/settings-panel.html`), avec `<textarea id="coreDirectives">`,
presets, compteur de caractères et bouton **« Sauvegarder comme défaut »**
(`state:save-defaults`, écriture immédiate + reconfiguration TTS à chaud).

### Tâche 5 — défauts et onboarding

* Gemini est le moteur par défaut (`engines.reasoning = 'gemini'`,
  `engines.voice = 'gemini'`, modèle `gemini-2.5-flash`) ;
* au démarrage, `runOnboardingIfNeeded()` : si `onboardingCompleted === false`,
  la fenêtre Réglages est **affichée** et l'événement IPC `trigger-onboarding`
  est envoyé à son renderer (relayé à l'iframe du panneau par `shell.html`) ;
* le panneau ouvre alors un modal qui met en surbrillance les trois champs
  obligatoires — « Nom de l'avatar », « Nom de l'utilisateur », « Clé API Gemini »
  (`class="missing"`) ;
* « Enregistrer et commencer » teste la clé (`ai:test-key`), écrit
  `state.json`, puis passe `onboardingCompleted` à `true`
  (`state:save-defaults` le fait aussi automatiquement dès que les trois champs
  sont remplis, puis `onboarding:complete` confirme).

## 3 bis. Gemini Live (conversation directe)

`desktop/live.js` (ajouté au dépôt) gère la session `BidiGenerateContent`.
`main.js` l'instancie (`initLive()`), une session par fenêtre demandeuse
(`owner = webContents.id`), et expose :

| Canal IPC | Sens | Usage |
|---|---|---|
| `live:start` (invoke) | renderer → main | `DESKTOP.liveStart({key, model, voice, instruction})` → `{ok, sessionId, model, voice}` |
| `live:stop`, `live:audio`, `live:audio-end`, `live:text` | renderer → main | pilotage de la session |
| `live:tool-response` | renderer → main | réponse à `set_emotion` |
| `live:event` | main → renderer | `ready`, `input-text`, `text`, `audio`, `tool-call`, `turn-complete`, `usage`, `closed`… |

**Instruction composée** (`desktop/lib/live-instruction.js`) — l'instruction de
l'app est conservée en tête, puis sont ajoutés, sans doublon :

1. l'identité `state.json` (« Tu es Sarra… et tu parles à Amine ») ;
2. les **coreDirectives** persistées (tâche 4) ;
3. un digest des **10 derniers échanges** de `chatHistory`, pour que la
   conversation directe garde la mémoire du chat texte ;
4. le rappel « appelle `set_emotion` plutôt que de dire que tu ne peux pas ».

Le tout est borné à 7600 caractères (`live.js` tronque à 8000).

**Mémoire des tours Live** : à chaque `turn-complete`, la transcription d'entrée
et la transcription de sortie sont assemblées puis écrites dans `state.json`
(`store.addExchange`), donc elles réapparaissent dans le chat texte et dans le
digest des sessions suivantes. Les sessions d'une fenêtre sont arrêtées à sa
fermeture (`liveManager.stopOwner`).

## 3 ter. Modèle VRM par défaut

L'app web ne chargeait aucun modèle d'elle-même. Le bloc ajouté au HTML tente
`fetch('sarra7.vrm')` puis `sarra7c.vrm` (≥ 1 Ko), appelle
`load(buffer, name, 'default-vrm', true)` — donc `applyDefaultAvatarAppearance`
pour le rendu argile — et signale le résultat :

* `DESKTOP.vrmLoaded(result)` → main → `vrm:status` → écran de démarrage masqué ;
* aucun fichier → `notifyStartup('error', …)` et `vrm:missing` : l'écran de
  démarrage affiche « Avatar 3D non chargé » avec les boutons **Réessayer** et
  **Ouvrir les réglages** (import d'un VRM `.vrm`).

## 3 quater. Lancement Windows sans console

`desktop/launch.vbs` installe les dépendances si besoin puis lance
`npm --prefix desktop start` avec `shell.Run command, 0, False` (fenêtre
masquée, non bloquant), journal dans `start.log`. `start.bat desktop` y mène.

## 4. Hôte vocal Python (préservé)

`desktop/lib/tts-bridge.js` est un client TCP du protocole existant :

```
→ {"type":"hello","client":"sarra-electron"}
→ {"type":"voices"}
→ {"type":"speak","id":12,"text":"…","voice":"Hortense","lang":"fr-FR","rate":1}
→ {"type":"stop"}
← {"type":"ready"} / {"type":"voices", …} / {"type":"start"|"boundary"|"end"|"error", …}
```

* `start` / `boundary` / `end` sont relayés au renderer, qui conserve son proxy
  de `speechSynthesis` et donc son recalage du lipsync sur les mots ;
* si rien n'écoute sur 8649, le pont **lance** `desktop/tts/tts_host.py`
  (repli décrit dans le README) ; sinon l'application passe en **mode
  silencieux** (elle répond `end` pour ne pas bloquer l'animation) ;
* `desktop/tts/tts_host.py` livré ici est un **hôte de repli sans son** (stdlib
  seulement) : il répond au protocole et émet de vrais repères de mots, ce qui
  permet de valider toute la chaîne sur une machine sans PyQt6. L'hôte
  PyQt6/QTextToSpeech reste celui de production.

## 5. Lancer

```bash
npm --prefix desktop install     # installe Electron
npm --prefix desktop start       # ajoute --no-sandbox (voir README)
```

Prérequis : Node.js ≥ 20 ; Python 3.11 + PyQt6 pour la voix Windows ;
`desktop/state.json` est créé/normalisé au premier lancement.

## 6. Ce qui reste à brancher (hors périmètre)

| Élément | État |
|---|---|
| Gemini Live (`liveStart`, `onLiveEvent`, `liveToolResponse`) | ✅ branché sur `desktop/live.js` ; clé prise dans les Réglages si l'app n'en fournit pas ; mémoire persistée à chaque tour. |
| `ttsAudio` (voix en ligne Gemini/Edge/ElevenLabs) | renvoie `{ok:false, error}` → repli automatique sur la voix Windows de l'app. |
| `ollamaChat`, `ollamaStatus`, `transcribeLocalAudio` | non exposés (l'app affiche « nécessite l'application Electron »). |
| `aiEmployeesList/Install/Open` | non exposés ; l'onglet correspondant de l'app reste inactif. |
| Icône de zone de notification (tray) | non créée (aucun `assets/tray.png` dans le dépôt) ; quitter via le menu contextuel de l'avatar, `Ctrl+Shift+Q` ou la fenêtre Réglages. |
| Chargement d'un VRM depuis le panneau natif | inutile : l'app le fait déjà (onglet « Sarra Studio »). |

## 7. Validation manuelle

1. Lancer : seule la fenêtre avatar apparaît (transparente, sans bordure, au-dessus).
2. Cliquer dans une zone vide de l'écran sous les pieds de l'avatar : le clic
   traverse la fenêtre (click-through).
3. Survoler l'avatar : les clics redeviennent actifs ; glisser avec le bouton
   gauche déplace la fenêtre ; la molette et les bords la redimensionnent.
4. `Ctrl+Shift+K` : les réglages s'ouvrent (onglet natif) ; re-appuyer les masque.
5. Renseigner les trois champs → « Sauvegarder comme défaut » →
   `state.json` contient les valeurs et `onboardingCompleted: true`.
6. Poser une question contenant un prénom : la réponse suivante doit s'en
   souvenir (10 derniers échanges injectés, visibles dans « Mémoire persistante »).
7. Activer le bouton micro (bas au centre) : la conversation directe Gemini Live
   démarre ; demander « souris-moi » → l'outil `set_emotion` doit être appelé et
   l'expression appliquée. Le tour apparaît ensuite dans « Mémoire persistante ».
8. `npm test` à la racine : **152 tests, 0 échec** (dont `desktop/live.test.js`
   et `desktop/state-ia.test.js`).

## 8. Sécurité

* clé API stockée **en clair** dans `state.json` (comme les clés
  `localStorage` de l'app) : utiliser une clé dédiée et un dossier de profil
  personnel ;
* `state.json` et les journaux sont exclus du serveur local (liste `DENY`) ;
* serveur lié à `127.0.0.1` sur un port éphémère, `Cache-Control: no-store` ;
* `contextIsolation: true`, `nodeIntegration: false` ; `sandbox: false`
  uniquement parce que le lanceur impose déjà `--no-sandbox` (README) ;
* permissions `media` accordées aux seules pages servies par ce serveur local.
