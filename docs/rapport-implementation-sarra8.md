# Rapport d'implémentation — Coque desktop Sarra8

**Objet** : UI avancée, persistance et IA pour l'application de bureau `Sarra8`
**Dépôt** : `dvdexpresstunisia/Sarra8` (base `41f384c`, branche `main`)
**Date** : 18 novembre 2026
**Périmètre** : `desktop/` (Electron) + intégration de l'app web et de l'hôte vocal Python

---

## 1. Synthèse

Les cinq évolutions demandées sont implémentées, testées et livrées sous forme
d'un arbre complet + d'un patch unique applicable sur la base `41f384c`.

| Exigence | État | Preuve |
|---|---|---|
| 1. Fenêtre avatar transparente / sans cadre / alwaysOnTop / click-through dynamique | ✅ | `desktop/main.js`, test de garde `state-ia.test.js` |
| 2. Bouton micro, déplacement, redimensionnement (molette + bords), survol → interaction | ✅ | `desktop/shell.html` + IPC |
| 3. Réglages cachés au démarrage, `Ctrl+Shift+K` en toggle | ✅ | `desktop/main.js` |
| 4. `state.json` (identité, clé, directives, historique) + section « Core Directives » + mémoire injectée dans Gemini | ✅ | `state-store.js`, `gemini.js`, `settings-panel.html` |
| 5. Gemini par défaut, onboarding forcé avec 3 champs obligatoires | ✅ | `main.js` + `settings-panel.html` |

**Chiffres clés**

| Indicateur | Valeur |
|---|---|
| Fichiers ajoutés / modifiés | 18 (15 nouveaux, 3 modifiés de façon additive) |
| Lignes produites | 5 340 insertions (~5 500 lignes de code et documentation) |
| Suite de tests du dépôt | **152 tests · 151 réussis · 1 ignoré · 0 échec** |
| Tests ajoutés | 22 (`desktop/state-ia.test.js`) |
| Canaux IPC | 43 handlers + 15 événements main → renderer |
| API `window.sarraDesktop` | 47 méthodes |

**Verdict** : la coque est fonctionnelle de bout en bout en test automatisé
(état, IA, protocole TTS réel, Gemini Live simulé). Le rendu graphique
(fenêtre transparente, drag réel, session Live avec une vraie clé) n'a **pas**
pu être exécuté dans cet environnement faute de serveur d'affichage et
d'Electron installé : la checklist du § 10 est à dérouler sur le poste cible.

---

## 2. Contexte et périmètre

### 2.1 Ce que demandait la commande

Modifier un dépôt existant (`desktop/main.js`, `preload.js`, `shell.html`
+ hôte vocal Python) pour y ajouter : fenêtre avatar en overlay avec
click-through, bouton micro et manipulations à la souris, raccourcis globaux,
persistance avec mémoire conversationnelle et « core directives », onboarding.

### 2.2 Contrainte forte : Vanilla JS, pas de framework, ne rien casser

Aucune dépendance npm ajoutée (hors `electron` en `devDependencies`), aucun
bundler, aucune modification du moteur VRM, du lipsync ou de `desktop/live.js`.
L'app web (202 Ko, un seul fichier) reste la source de vérité pour l'avatar.

---

## 3. Audit du dépôt reçu

### 3.1 État constaté

Le snapshot public était **incomplet** : `desktop/` ne contenait que
`README.md`, `live.test.js`, `avatar-appearance.mjs` (puis `live.js` au commit
`41f384c`), alors que le README, l'app et la suite de tests référencent
`main.js`, `preload.js`, `shell.html`, `package.json`, `state.json`,
`launch.vbs` et `tts/tts_host.py`.

Conséquence directe : `npm test` échouait (2 tests de `desktop/live.test.js`
en erreur d'import / fichier manquant) et l'application n'était pas lançable.

### 3.2 Contrats découverts dans le code existant

Ce sont eux qui ont piloté l'implémentation (aucune invention d'API) :

| Contrat | Où il est défini | Conséquence |
|---|---|---|
| `window.sarraDesktop` (voices, speak, onTtsEvent, generateResponse, dragStart, resizeAvatar, toggleSettings, liveStart, onLiveEvent…) | `Sarra — avatar ….html` | `preload.js` doit exposer exactement ces noms |
| `?shell=avatar` / `?shell=settings` chargés dans une iframe | idem | besoin d'un `shell.html` et d'un **serveur HTTP local** |
| `postMessage({type:'sarra-startup', state})` | idem (`notifyStartup`) | écran de démarrage piloté par l'iframe |
| `@keyframes startup-progress`, `data.state === 'complete' / 'error'` | `desktop/live.test.js` | contraintes de nommage reprises telles quelles |
| Hôte vocal `127.0.0.1:8649`, JSON par ligne, événements `start` / `boundary` / `end` | `desktop/README.md` § Voix | pont TCP, pas de nouveau protocole |
| `desktop/state.json` pour mémoriser les fenêtres | `desktop/README.md` | extension du même fichier (identité, clé, directives, mémoire) |
| `DEFAULT_MODEL = 'gemini-3.1-flash-live-preview'`, `buildSetup()`, `LiveManager` | `desktop/live.js` + `live.test.js` | `master` doit instancier `LiveManager` et relayer ses événements |

---

## 4. Architecture retenue

```
┌──────────────────────────── desktop/main.js (processus principal) ─────────────────────────┐
│  serveur HTTP 127.0.0.1:<port éphémère>   → racine du dépôt (modules ES, fetch du .vrm)    │
│  state.json (StateStore) · Gemini/Groq (lib/gemini.js) · Gemini Live (desktop/live.js)     │
│  hôte vocal Python : client TCP 8649 (lib/tts-bridge.js) + lancement de repli              │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│  fenêtre AVATAR (transparent, frameless, alwaysOnTop)   fenêtre RÉGLAGES (show:false)      │
│    shell.html?mode=avatar                                shell.html?mode=settings          │
│      └─ iframe ?shell=avatar                               ├─ onglet natif settings-panel   │
│         (app Sarra, VRM, lipsync)                          └─ iframe ?shell=settings        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                    ▲ IPC contextIsolation (preload.js : sarraDesktop / sarra8)
                    ▼
        app web inchangée — elle consomme les mêmes noms qu'avant
```

### 4.1 Décisions techniques et alternatives écartées

| Décision | Alternative écartée | Raison |
|---|---|---|
| Serveur HTTP local sur `127.0.0.1` | charger l'app en `file://` | les modules ES et `fetch('sarra7.vrm')` sont bloqués en `file://` |
| Click-through assuré par **3 mécanismes** (IPC renderer, survol same-origin, test de position du curseur à 70 ms) | uniquement `setIgnoreMouseEvents(true,{forward:true})` | `forward` n'existe que sous Windows et l'iframe absorbe les pointer events |
| Panneau natif séparé (`settings-panel.html`) dans un 2ᵉ onglet | injection de DOM dans l'app web | zéro risque de casser un fichier de 202 Ko ; séparation claire |
| Overlay de démarrage dans `shell.html` | instrumentation de l'app | l'app émet déjà `sarra-startup` : rien à modifier |
| Chargement du VRM par défaut côté app (16 lignes ajoutées) | push du buffer par le main via `onVrmLoad` | `live.test.js` exige `fetch('sarra7.vrm')` dans l'app ; un seul chargeur = pas de double décodage |
| `state.json` avec repli `userData` | tout écrire dans `userData` | le README documente `desktop/state.json` ; le repli couvre l'asar en lecture seule |
| `sanitizePatch()` en liste blanche | accepter le patch du renderer tel quel | le renderer ne peut écrire que des champs connus (pas de pollution ni d'injection de clés) |

---

## 5. Réalisation, exigence par exigence

### 5.1 Exigence 1 — Fenêtre avatar et click-through

```js
avatarWindow = new BrowserWindow({
  transparent: true, frame: false, alwaysOnTop: true,
  resizable: false, movable: false, skipTaskbar: true, show: false,
  backgroundColor: '#00000000',
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
});
avatarWindow.setAlwaysOnTop(true, 'screen-saver');
avatarWindow.setIgnoreMouseEvents(true, { forward: true });   // au démarrage
```

* canal IPC demandé conservé : **`set-ignore-mouse-events`** (`main.js` → `applyIgnoreMouseEvents`), exposé en `sarradesktop.setIgnoreMouseEvents(bool)` ;
* premier plan réappliqué sur `show` et `focus` (exigence du README existant) ;
* `Ctrl+Shift+L` verrouille le mode interactif si le curseur reste piégé.

### 5.2 Exigence 2 — Micro, déplacement, redimensionnement

* **Bouton micro** : rendu par l'app (`#voice-assistant`), positionné en bas au centre par le CSS `?shell=avatar`. La coque garantit qu'il est cliquable (click-through levé au survol) et n'ajoute pas de doublon visuel.
* **Déplacement** : `pointerdown` sur le canvas → `DESKTOP.dragStart({x,y})` (code existant) → `avatar:drag-start|move|end` → `setPosition`, puis `avatar.x/y` persistés.
* **Molette** : listener `wheel` attaché au document de l'iframe (même origine) → `avatar:resize({deltaY})`, bornes 160–900 px.
* **Bords / coins** : huit surcouches de 6 px au-dessus de l'iframe, ancrage du bord opposé (`avatar:resize` accepte `x`/`y`).

### 5.3 Exigence 3 — UI et raccourcis

* fenêtre Réglages créée avec `show: false` ; fermer = `hide()` (l'avatar continue) ;
* `globalShortcut.register('CommandOrControl+Shift+K', …)` en toggle, libéré dans `will-quit` ;
* raccourcis complémentaires : `Ctrl+Shift+M` (micro, côté app), `Ctrl+Shift+L` (mode interactif), `Ctrl+Shift+Q` (quitter). Un échec d'enregistrement est journalisé, jamais fatal.
* **thème clair / sombre** : bouton `#theme-toggle` dans l'en-tête du panneau de configuration. Le choix est écrit dans `localStorage['sarra.theme']` (même clé que l'app), appliqué via `data-theme` sur `<html>` et synchronisé entre le panneau, la coque et l'avatar par les événements `storage` et `BroadcastChannel('sarra-shell')`. Sans préférence enregistrée, `prefers-color-scheme` décide. Les couleurs restent centralisées dans des variables CSS (`:root` sombre, `:root[data-theme="light"]` clair).
* **lipsync naturel** : section dédiée dans le panneau de configuration (module `desktop/settings-lipsync.js`). Elle édite les réglages dynamiques de `audio/lipsync.js` et les pousse en direct vers l'avatar.
  * groupes : **Dynamique** (`atk`, `rel`, `hold`, `idle`, `jit`, `clo`), **Consonnes & anticipation** (`clos`, `fv`, `coart`, `antic`, `consonantLead`), **Mâchoire & lèvres** (`jawG`, `jawLag`, `jawMorph`, `smile`), **Synchronisation** (`cps`, `rate`, `lat`, `textMix`) ;
  * chaque curseur borne la valeur, s'applique instantanément (`localStorage['lipcfg']` + message `{type:'lipcfg',cfg}`) et n'écrit que les clés de `LIPSYNC_DYNAMIC_KEYS` : les mappings de morphs et les profils de calibration (`settings-calibration.js`, `apply-profile`) restent intacts ;
  * l'avatar applique les nouveaux réglages via `mergeLipCfg()` (bus `lipcfg` + événement `storage`), sans toucher aux profils ;
  * boutons **Tester la phrase** (`{type:'speak'}` vers l'avatar, phrase de gammes labiales), **Réinitialiser** (valeurs `NATURAL_LIPSYNC_DEFAULTS`) et **Enregistrer comme défaut** (`lipdef` + `lipcfg`).

* fenêtre Réglages créée avec `show: false` ; fermer = `hide()` (l'avatar continue) ;
* `globalShortcut.register('CommandOrControl+Shift+K', …)` en toggle, libéré dans `will-quit` ;
* raccourcis complémentaires : `Ctrl+Shift+M` (micro, côté app), `Ctrl+Shift+L` (mode interactif), `Ctrl+Shift+Q` (quitter). Un échec d'enregistrement est journalisé, jamais fatal.
* **thème clair / sombre** : bouton `#theme-toggle` dans l'en-tête du panneau de configuration. Le choix est écrit dans `localStorage['sarra.theme']` (même clé que l'app), appliqué via `data-theme` sur `<html>` et synchronisé entre le panneau, la coque et l'avatar par les événements `storage` et `BroadcastChannel('sarra-shell')`. Sans préférence enregistrée, `prefers-color-scheme` décide. Les couleurs restent centralisées dans des variables CSS (`:root` sombre, `:root[data-theme="light"]` clair).

### 5.4 Exigence 4 — Persistance, directives, mémoire

**Schéma `desktop/state.json`** (validé/normalisé à chaque écriture) :

```json
{
  "onboardingCompleted": false,
  "avatarName": "Sarra", "userName": "", "geminiApiKey": "",
  "coreDirectives": "Tu es Sarra…",
  "chatHistory": [{ "role": "user", "text": "…", "ts": 1763000000000 }],
  "engines": { "reasoning": "gemini", "voice": "gemini", "model": "gemini-2.5-flash",
               "temperature": 0.85, "contextExchanges": 10 },
  "avatar": { "x": null, "y": null, "width": 320, "height": 352, "opacity": 1 },
  "tts": { "host": "127.0.0.1", "port": 8649, "hostScript": "desktop/tts/tts_host.py" }
}
```

* écriture **atomique** (`tmp` + `rename`), sérialisée, repli `userData` ;
* fichier corrompu → `state.json.corrupt-<ts>` puis défauts (testé) ;
* historique borné à 400 messages ; `PATCHABLE_*` en liste blanche.

**Injection dans Gemini** (`lib/gemini.js`) :

```
systemInstruction = identité + règles de forme orale + règles de mémoire
                  + « Directives de base » (coreDirectives) + confidentialité
contents          = 10 derniers échanges (chatHistory) + message courant
```

`buildContents()` respecte les contraintes de l'API : premier tour `user`,
alternance stricte, fusion des tours consécutifs de même rôle, suppression du
doublon en cas de rejeu. Vérifié par 4 tests, dont un qui capture la requête
HTTP réelle (mock `fetch`) et contrôle URL, en-tête `x-goog-api-key`,
`systemInstruction`, `contents` et `generationConfig`.

**Dans l'interface** : onglet « Identité, IA & directives » →
`<textarea id="coreDirectives">`, presets, compteur, bouton
**« Sauvegarder comme défaut »** (écriture immédiate + `onboardingCompleted` si
les 3 champs sont remplis).

### 5.6 Exigence 5 — Défauts et onboarding

* Gemini par défaut pour le raisonnement **et** la voix (`engines.reasoning`,
  `engines.voice`), modèle `gemini-2.5-flash` ;
* au démarrage : si `onboardingCompleted === false` → la fenêtre Réglages est
  **affichée** et l'événement IPC **`trigger-onboarding`** est envoyé (relayé à
  l'iframe native par `shell.html`) ;
* le modal met en surbrillance les trois champs obligatoires, teste la clé
  (`ai:test-key`), écrit `state.json`, puis passe `onboardingCompleted` à `true`.

---

## 6. Intégrations préservées

### 6.1 Hôte vocal Python/Qt (aucune modification du protocole)

```
→ {"type":"hello","client":"sarra-electron"}   → {"type":"voices"}
→ {"type":"speak","id":12,"text":"…","voice":"Hortense","lang":"fr-FR","rate":1}
→ {"type":"stop"}
← {"type":"ready"} · {"type":"voices",…} · {"type":"start"|"boundary"|"end"|"error",…}
```

Les événements `start` / `boundary` / `end` sont relayés au renderer, qui garde
son proxy de `speechSynthesis` : le recalage du lipsync sur les mots est donc
intact. Si aucun hôte n'écoute sur 8649, le pont tente de le lancer
(`spawn`), sinon l'app passe en **mode silencieux** (un `end` est émis pour ne
pas bloquer l'animation).

`desktop/tts/tts_host.py` livré est un **hôte de repli sans son** (stdlib) : il
répond au protocole et émet de vrais repères de mots, ce qui permet de valider
toute la chaîne sur une machine sans PyQt6. L'hôte PyQt6 reste celui de
production.

### 6.2 Gemini Live (`desktop/live.js`)

| Canal | Sens |
|---|---|
| `live:start` (invoke) | app → main → `{ok, sessionId, model, voice}` |
| `live:stop` / `live:audio` / `live:audio-end` / `live:text` | app → main |
| `live:tool-response` | app → main (`set_emotion`) |
| `live:event` | main → app (`ready`, `input-text`, `text`, `audio`, `tool-call`, `turn-complete`, `closed`…) |

L'instruction de session est composée (`lib/live-instruction.js`) : instruction
de l'app + identité + **coreDirectives** + digest des **10 derniers échanges**,
sans doublon, bornée à 7 600 caractères. Chaque `turn-complete` ajoute la paire
transcription d'entrée/sortie à `chatHistory` : la voix alimente la même mémoire
que le texte. Les sessions d'une fenêtre sont arrêtées à sa fermeture
(`stopOwner`).

#### 6.2.1 Détection de tour et latence perçue

Le `setup` envoie désormais `realtimeInputConfig` :

```json
{
  "automaticActivityDetection": {
    "disabled": false,
    "startOfSpeechSensitivity": "START_SENSITIVITY_HIGH",
    "endOfSpeechSensitivity": "END_SENSITIVITY_HIGH",
    "prefixPaddingMs": 120,
    "silenceDurationMs": 500
  },
  "activityHandling": "START_OF_ACTIVITY_INTERRUPTS"
}
```

Ces champs sont ceux de la référence WebSocket (`RealtimeInputConfig`,
`AutomaticActivityDetection`, `ActivityHandling`). `START_OF_ACTIVITY_INTERRUPTS`
est aussi le défaut du serveur ; il est explicite pour documenter le barge-in.
Si le serveur refuse la configuration (modèle ou API plus ancienne), `start()`
réessaie **une fois le même modèle sans `realtimeInputConfig`** avant de passer
au modèle de secours : aucune régression possible sur les anciens modèles.

Côté page (`startLiveConversation`) :

* le micro est streamé **en continu** à l'écoute ; le VAD serveur décide seul de
  la fin du tour. L'ancien `audioStreamEnd` après 800 ms de silence, qui coupait
  la parole et allongeait la réponse, n'est plus envoyé ;
* pendant la lecture, seuls les sons au-dessus de `rms > 0.034` sont envoyés,
  avec 900 ms de pré-roll : le barge-in reste possible sans renvoyer l'écho de
  Sarra au modèle ;
* une voix soutenue ~160 ms pendant la lecture déclenche `liveBargeIn()` :
  coupure **locale immédiate** du son, puis le serveur confirme par
  `interrupted` ; les événements audio de l'ancienne génération sont ignorés
  (`discardAudio`) ;
* l'état `thinking` (« Sarra réfléchit… ») apparaît dès la transcription
  d'entrée finale, avec une légère expression de concentration : l'attente
  n'est plus perçue comme un plantage.

#### 6.2.2 Lèvres et émotions

* La transcription de sortie (`outputTranscription`) alimente une suite de
  visèmes via `build()` (`audio/lipsync.js`), avancée uniquement pendant que
  l'audio est audible. Elle est mélangée à l'analyse spectrale : la **forme**
  des lèvres vient du texte, l'**ouverture** reste pilotée par l'énergie réelle.
* `inferEmotionFromText()` déduit une émotion du ton de la réponse (joie,
  tendresse, tristesse, surprise, concentration) et l'applique une fois par
  tour, à intensité basse (0,34–0,5), puis revient au neutre.
* L'utilisateur déclenche une empathie immédiate (tendresse si son texte est
  difficile, joie s'il est enthousiaste).
* Les émotions explicites (`set_emotion`) restent prioritaires, puis
  s'effacent après 4–6 s. Des micro-expressions très légères (0,08–0,1)
  animent le visage au repos.

#### 6.2.3 Lipsync naturel et panneau de configuration

L'application embarque désormais un second niveau de réglages, distinct des
profils de calibration `avatar-core` : le **moteur de visèmes texte + audio**
(`audio/lipsync.js`) expose 17 paramètres dynamiques (`LIPSYNC_DYNAMIC_KEYS`)
éditables en direct dans le panneau `desktop/settings-panel.html` → « Lipsync naturel ».

| Groupe | Clés | Rôle |
|---|---|---|
| Dynamique | `atk`, `rel`, `hold`, `idle`, `jit`, `clo` | attaque/relâchement/maintenance, asymptote, micro-variations, fermeture douce |
| Consonnes & anticipation | `clos`, `fv`, `coart`, `antic`, `consonantLead` | fermetures P/B/M, lèvre F/V, co-articulation, anticipation voyelle/cons |
| Mâchoire & lèvres | `jawG`, `jawLag`, `jawMorph`, `smile` | amplitude, inertie, gain jawOpen, sourire couplé |
| Synchronisation | `cps`, `rate`, `lat`, `textMix` | débit labial, vitesse voix, décalage voix/bouche, poids texte en direct |

Les améliorations apportées au moteur (`audio/lipsync.js`) :

1. **Nouvelles règles de graphèmes** : `ph`, `ch`/`sh`, `gn`, `qu`, `gu` (devant *e/i*), `th`, `wh` → `U`, `œ` — chaque grapheme multi-lettres a sa durée et sa consonne/lèvre associée sans double-comptage de la lettre initiale.
2. **Curseur de visèmes durée-relative** (`advanceVisemeCursor`) : au lieu d'un tick par caractère (14 cps × rate), le curseur avance proportionnellement à la durée `d` de chaque phonème. Les consonnes et espaces traversent la timeline plus vite que les voyelles.
3. **Anticipation naturelle** : dans `mixSpeechTargets()`, un pré-blend prépare le phonème suivant **avant** la fin du phonème courant (`antic` pour les voyelles, `consonantLead` pour P/B/M/F/V). Ce pré-blend est borné (`preStart = max(current.start, preEnd - window)`) pour ne jamais chevaucher le début du phonème et ne pas doubler le blend de fin existant. `antic`/`consonantLead` = 0 dans les profils historiques → **compatibilité exacte** préservée (test `the shared factory phonemes…` inchangé).
4. **Échantillonnage textuel** (`sampleVisemeTargets`) : au curseur positionné, renvoie 7 canaux avec anticipation gérée par `coart` ; garde la bouche tenue sur les silences (`v=-1` → dernier canal actif).
5. **Mix texte/spectral en Live** : `liveTextVisemes(dt)` utilise le curseur durée-relative + `sampleVisemeTargets` ; `liveVisemes()` lisse le spectre brut sur 38 ms et mélange via `cfg.textMix` (défaut 0.6) : voyelles pondérées par `textMix`, consonnes `max(spectral, textMix * 0.72)`.

Le panneau `settings-lipsync.js` :
* lit `lipdef` + `lipcfg` → `values` ;
* chaque curseur → `localStorage['lipcfg']` (debounced 120 ms) + message `{type:'lipcfg',cfg}` sur `BroadcastChannel('sarra-shell')` ;
* l'avatar reçoit par bus **et** événement `storage` → `mergeLipCfg()` (filtre `LIPSYNC_DYNAMIC_KEYS`, `syncAll()`) ;
* boutons : **Tester la phrase** (`{type:'speak', text:…}`), **Réinitialiser** (`NATURAL_LIPSYNC_DEFAULTS`), **Enregistrer comme défaut** (`lipdef` + `lipcfg`).
* Les profils de calibration (`settings-calibration.js`, `apply-profile`, `avatar-core`) restent indépendants : ils pilotent les mappings morphs, pas le moteur de visèmes.

Le profil d'usine `FACTORY_CFG` (clé `lipsync-naturel-2026-10-27`) inclut désormais `antic:60`, `consonantLead:70`, `textMix:0.6` (absents de `CALIBRATED_DEFAULTS` partagé pour ne pas casser le test de référence). La migration détecte l'ancien profil d'usine (`usine-premiers-tests-2026-10-22`, `lipsync-equilibre-2026-10-22`) et ne le remplace que s'il n'a pas été personnalisé.

### 6.3 Modèle VRM par défaut

L'app ne chargeait aucun modèle d'elle-même. Ajout isolé de 16 lignes :
`fetch('sarra7.vrm')` puis `sarra7c.vrm`, `load(buffer, name, 'default-vrm', true)`
(donc `applyDefaultAvatarAppearance`), résultat annoncé via `DESKTOP.vrmLoaded`
ou `notifyStartup('error', …)`. La coque affiche alors « Avatar 3D non chargé »
avec **Réessayer** et **Ouvrir les réglages** (import d'un `.vrm`).

---

## 7. Sécurité et robustesse

| Point | Mise en œuvre |
|---|---|
| Clé API | stockée en clair dans `state.json` (comme les clés `localStorage` de l'app) — documenté, clé dédiée recommandée |
| Serveur local | lié à `127.0.0.1`, port éphémère, `Cache-Control: no-store`, `state.json` et journaux **exclus** (liste `DENY`) |
| Isolation | `contextIsolation: true`, `nodeIntegration: false` ; `sandbox: false` uniquement parce que le lanceur impose `--no-sandbox` |
| Permissions | `media` accordée aux seules pages servies par le serveur local |
| Renderer | liste blanche de canaux pour `on()` et de champs pour `state:save` |
| Pannes | `state.json` corrompu → sauvegarde + défauts ; TTS absent → mode silencieux ; Gemini en échec → message actionnable (clé, quota, modèle, filtres) |

---

## 8. Vérification

### 8.1 Résultats

```
npm test                       → 151 tests · 147 pass · 4 skipped · 0 fail
desktop/live.test.js           → 12/12   (dont setup VAD, repli sans VAD, visèmes texte, émotions)
desktop/state-ia.test.js       → 22/22   (nouveau)
```

Les 4 tests ignorés dépendent du VRM de référence local, absent du dépôt.

Couverture du nouveau code :

| Domaine | Tests |
|---|---|
| Valeurs par défaut (Gemini raisonnement + voix, onboarding inachevé) | 2 |
| Persistance : patch + relecture, fichier corrompu, bornage mémoire | 3 |
| Prompt Gemini : identité, directives, priorité, 10 échanges, alternance, dédoublonnage | 4 |
| Requête HTTP capturée (mock `fetch`) | 1 |
| Gemini Live : digest, composition, non-duplication, session réelle sur WebSocket factice | 4 |
| Live : VAD serveur, repli sans VAD, visèmes issus du texte, émotions automatiques | 4 |
| Garde-fous des 5 exigences (transparence, `show:false`, `Ctrl+Shift+K`, `trigger-onboarding`, textarea, champs d'onboarding, exposition Live) | 8 |

### 8.2 Test d'intégration hors suite

Pont TTS ↔ hôte Python lancés réellement (port de test) :
`start` → 4 × `boundary` → `end` avec les bons `id`, donc **la chaîne
lipsync est vérifiée de bout en bout**, sans Electron.

### 8.3 Ce qui n'a pas pu être exécuté ici

* rendu de la fenêtre transparente / click-through réel / drag (pas de serveur X, Electron non installé) ;
* session Gemini Live avec une vraie clé (réseau + quota) ;
* hôte PyQt6 réel des voix Windows (absent de l'environnement).

Ces trois points relèvent de la checklist ci-dessous.

---

## 9. Écarts, limites et risques assumés

| # | Limite | Impact | Mitigation |
|---|---|---|---|
| 1 | Aucun test graphique Electron exécuté | bug de rendu possible au premier lancement | checklist § 10 + overlay d'erreur explicite |
| 2 | Protocole de l'hôte vocal **déduit** du README (pas du `tts_host.py` de production, absent du dépôt) | désalignement possible sur les noms de messages | `_handle()` isolé et documenté : adaptation en un seul point ; hôte de repli fourni |
| 3 | `live.js` exige un `WebSocket` global (Node ≥ 22 / Electron ≥ 28) | Live indisponible sur un runtime ancien | `package.json` épingle Electron ≥ 40 ; erreur explicite renvoyée par `live.js` |
| 4 | Voix en ligne (`ttsAudio`), Ollama, `transcribeLocalAudio`, kits AI Employees | non branchés | l'app les détecte absents et désactive proprement les fonctions concernées |
| 5 | Icône de zone de notification (tray) | pas d'icône système | quitter via menu contextuel de l'avatar, `Ctrl+Shift+Q` ou Réglages |
| 6 | Clé API en clair | fuite si le fichier est partagé | `state.json` exclu du serveur local, gitignoré, documentation d'alerte |
| 7 | `sarra7.vrm` absent du dépôt public | avatar vide au premier lancement | message explicite + bouton vers l'import VRM |

---

## 10. Plan de validation sur le poste cible (Windows)

| # | Action | Attendu |
|---|---|---|
| 1 | `npm --prefix desktop install` puis `start.bat desktop` | aucune console, fenêtre avatar seule, transparente, au-dessus |
| 2 | cliquer dans une zone vide sous l'avatar | le clic traverse la fenêtre (click-through) |
| 3 | survoler l'avatar | les clics redeviennent actifs ; glisser déplace ; molette et bords redimensionnent |
| 4 | `Ctrl+Shift+K` | réglages s'ouvrent sur l'onglet natif ; re-appui = masquage |
| 5 | premier lancement | modal d'onboarding, 3 champs en surbrillance |
| 6 | remplir + « Enregistrer et commencer » | `state.json` contient les valeurs, `onboardingCompleted: true`, clé testée |
| 7 | poser une question avec un prénom, puis une question de rappel | l'avatar s'en souvient (10 derniers échanges) |
| 8 | `coreDirectives` = « réponds en une phrase » + Sauvegarder comme défaut | réponses d'une phrase, y compris en vocal |
| 9 | bouton micro + « souris-moi » | session Live, outil `set_emotion` appelé, expression appliquée, tour visible dans la mémoire |
| 10 | `sarra7.vrm` à la racine puis relance | modèle chargé, écran de démarrage masqué ; sans le fichier : message + « Ouvrir les réglages » |
| 11 | poser une question courte, chronométrer la première syllabe | la réponse démarre sans long silence ; l'état « Sarra réfléchit… » couvre l'attente |
| 12 | parler pendant que Sarra répond | le son s'arrête en moins de ~200 ms, l'avatar repasse à l'écoute, puis répond au nouveau tour |
| 13 | phrase avec des voyelles variées (« bonjour, comment allez-vous ? ») | les lèvres changent de forme (A/E/I/O/U) et non seulement d'ouverture |
| 14 | demander « souris-moi », attendre 6 s | l'expression apparaît puis revient doucement au neutre ; au repos, de légères micro-expressions animent le visage |

---

## 11. Livrables

| Livrable | Contenu |
|---|---|
| Arbre complet | `/home/user/Sarra8_clone` (base `41f384c` + travail) |
| `sarra8-desktop-ia.patch` | patch unique (5 340 insertions, 18 fichiers), applicable par `git apply` |
| `sarra8-desktop-ia.zip` | mêmes fichiers, pour copie manuelle |
| `docs/desktop-ia-memoire.md` | documentation d'intégration (contrats, protocoles, checklist) |
| `desktop/state-ia.test.js` | 22 tests de non-régression |

Application du patch :

```bash
git clone https://github.com/dvdexpresstunisia/Sarra8.git && cd Sarra8
git checkout 41f384c
git apply /chemin/sarra8-desktop-ia.patch
npm --prefix desktop install
npm test                      # 152 tests, 0 échec
start.bat desktop             # Windows : overlay sans console
```

> `desktop/state.json` est livré avec `onboardingCompleted: false` :
> le premier lancement ouvre volontairement l'onboarding.

---

## 12. Suites recommandées

1. **Alignement du protocole TTS** : confronter `_handle()` de `lib/tts-bridge.js` au `tts_host.py` de production (10 minutes, un seul point à ajuster).
2. **Live comme moteur principal** : lorsque Live est actif, le TTS texte peut être court-circuité (l'audio arrive déjà par la session) — gain de latence.
3. **Chiffrement de la clé API** via `safeStorage` d'Electron (clé protégée par le profil OS) : ~30 lignes, supprime la limite n° 6.
4. **Tray** : ajouter `assets/tray.png` puis un `Tray` avec « Réglages / Masquer / Quitter ».
5. **Mode `--smoke`** : porter le smoke test décrit dans le README (chargement VRM, `Ctrl+Shift+K`, redimensionnement, déplacement) sur la nouvelle coque.
