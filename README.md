# SuperSarra

Sarra est un avatar 3D au format VRM. Le même moteur de visage pilote l’atelier web et la fenêtre flottante Electron : émotions, regard, clignements et mouvements de bouche. **Aucune clé API, aucun micro et aucun service vocal ne sont nécessaires pour essayer le visage.**

## Essayer l’avatar dans un navigateur

À la racine du dépôt, avec Node.js 20+ et npm :

```sh
npm --prefix demo ci
npm run demo
```

Sous Windows, vous pouvez aussi lancer `start.bat`. Ouvrez l’adresse locale indiquée par Vite, puis cliquez sur **Importer un VRM** pour charger un modèle local que vous avez le droit d’utiliser. Aucun avatar VRM n’est inclus dans le dépôt. Essayez **Joie**, puis **P** et **F** ; **Relâcher les lèvres** enlève la pose de bouche sans enlever l’émotion. Glissez sur le portrait pour le faire pivoter. **Recentrer** rétablit le cadrage.

**Importer un VRM** charge un fichier local et conserve ses matériaux. Les commandes non prises en charge par son rig sont désactivées. Les profils de calibration sont associés au modèle par son identifiant, son empreinte SHA-256 et la signature de son rig. Utilisez `localhost` ou HTTPS pour l’import/export des profils. Les boutons de pose restent utilisables sans son.

### Voix et micro dans l’atelier

- Sous le portrait, saisissez une phrase, choisissez une **voix installée** et cliquez sur **Parler** (ou appuyez sur Entrée). **Arrêter** coupe la lecture. Sans voix utilisable, l’atelier signale le problème au lieu de simuler la parole.
- **Activer le micro** demande l’autorisation du navigateur : les lèvres suivent le son réel. **Couper le micro** libère l’entrée. Le micro d’ambiance n’enregistre pas, ne transcrit pas et n’envoie rien à un fournisseur IA. Les émotions restent disponibles pendant la parole.
- Les fonctions audio web sont partagées avec l’application complète : même profil d’usine, débit, phonèmes, suivi des mots lorsque la voix les fournit, analyse micro et lissage de la mâchoire. Les profils `lipdef`/`lipcfg` de la **même origine** sont lus sans écriture. Le profil privé d’Electron ne se transfère pas automatiquement dans le navigateur.
- Si le cadre d’aperçu bloque le micro, ouvrez l’atelier dans un onglet HTTPS (ou sur `localhost`) et accordez l’autorisation. Les voix proposées dépendent du système ; l’atelier n’installe ni ne télécharge de moteur vocal. Quitter l’onglet, réinitialiser le visage ou changer de modèle arrête l’audio.

L’atelier utilise la branche **Web Speech + Web Audio** de Sarra. La conversation Gemini Live, les voix et les services nécessitant le pont Electron restent dans l’application de bureau. [Contrôles de l’intégration audio](docs/audio-atelier.md).

Pour tester la version compilée :

```sh
npm run demo:build
npm --prefix demo run preview
```

Les dépendances 3D sont servies localement par l’atelier. Le dépôt exclut les modèles VRM ; ajoutez un modèle localement pour les essais, sans l’inclure dans un build ou un push public à moins de disposer des droits de redistribution.

## Application complète sous Windows

Avec Node.js 22.12+ recommandé pour les dépendances Electron :

```sh
npm --prefix desktop ci
npm run desktop
```

Après installation, `start.vbs` lance aussi la fenêtre flottante. **Ctrl+Shift+K** ouvre les réglages. Le visage est calculé dans la fenêtre avatar uniquement ; Réglages lui envoie ses commandes sans créer un second contexte WebGL. L’application complète utilise une import map CDN, contrairement à l’atelier compilé. La voix Windows et les fournisseurs IA ont leurs propres prérequis : [guide bureau](desktop/README.md).

## Vérifier une modification

| Commande | Ce qu’elle vérifie |
| --- | --- |
| `npm test` | Suites du moteur facial, de l’audio partagé, de l’utilitaire Decisions et des modules desktop ; sans installation d’Electron ni appel à un fournisseur. |
| `npm --prefix demo test` | Cadrage et visibilité sur de la géométrie Three.js, après `npm --prefix demo ci`. |
| `npm run bench:avatar` | Coût CPU de 10 000 applications de poids sur un rig reconstruit à partir d’un VRM local facultatif à `avatar-core/sarra7.vrm` (hors GPU et audio). |
| `npm run demo:build` | Compilation de l’atelier et résolution de ses ressources locales. |
| `npm run desktop:smoke` | Test d’intégration natif, à lancer dans une session graphique Windows avec Electron installé. |

## Se repérer

- [`avatar-core/`](avatar-core/README.md) : moteur facial sans dépendance à Three.js, adaptateur VRM, calibration et outils de cadrage partagés.
- [`audio/`](audio/) : profil, phonèmes français, repères de parole, acquisition micro et chemin de synthèse locale communs aux deux interfaces.
- [`demo/`](demo/) : atelier autonome pour voir les poses, faire parler Sarra et animer le visage au micro ; [`desktop/`](desktop/README.md) : fenêtres, voix et pont Electron.
- `Sarra — avatar VRM & lipsync avancé.html` : page de l’application complète, aussi utilisable avec `start-browser.bat` sous Windows.
- [`ai-employees-main/`](ai-employees-main/) : kits fournis pour le panneau Équipe IA, indépendants du rendu.
- [`docs/decisions.md`](docs/decisions.md) : documentation d’origine du helper HTTP `decisions.js`.
- [`docs/validation-avatar.md`](docs/validation-avatar.md) : mesures et protocole de vérification de ce correctif. Les rapports `PHASE*.md` décrivent des campagnes antérieures, parfois avec d’autres versions du modèle.
