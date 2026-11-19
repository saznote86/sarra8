# Atelier : réemploi du système audio de Sarra

## Ce qui est partagé

`audio/profile.js` contient les valeurs d’usine issues du dépôt d’origine. `audio/lipsync.js` contient la segmentation française (A, E, I, O, U, P, F), l’alignement sur les mots, le recalage `boundary`, l’analyse spectrale du micro, les gains et les courbes de mouvement. `audio/browser.js` utilise `SpeechSynthesisUtterance` et le graphe micro d’origine : source → analyseur FFT 1024, lissage 0,5, sans retour vers les haut-parleurs. Ces trois modules sont **importés par les deux interfaces**.

L’atelier utilise leurs sorties sur le VRM déjà affiché. Il ne lance pas un second rendu, un service TTS ou un assistant conversationnel. Le bouton Parler lit le texte donné ; le micro d’ambiance anime les lèvres, sans reconnaissance de parole. Aucune demande de micro ni lecture ne démarre à l’ouverture. La voix et les services natifs du bureau continuent d’utiliser leur pont existant. Les clés et l’historique de conversation ne sont pas lus par l’atelier.

## Contrôles réalisés sous Linux

- Node.js 20 : 154 tests réussis avec `npm test` (1 export VRM optionnel absent, ignoré), puis 3 tests de caméra réussis. Installation propre de `demo` et compilation Vite validées.
- Comparaison numérique avec `c352b58` sur **540 images** (3 phrases × 180 pas à 60 Hz) : mêmes sept canaux, ouverture de mâchoire et poids de morphs à entrées identiques. Cas couverts : estimation sur le texte, piste avec marques de mots et temps audio, événements de frontières de mots. Ce contrôle ne mesure pas une précision acoustique en millisecondes.
- **Synthèse réelle dans Chromium** : sélection d’une voix française du système via Web Speech, lecture d’une phrase, animation du VRM et événement de fin. Un signal PCM non silencieux a été mesuré sur une sortie virtuelle. La voix Linux installée pour ce test n’est pas une dépendance du projet ; ce test ne valide pas SAPI/Qt sous Windows.
- **Micro** : signal WAV de test fourni comme entrée virtuelle de Chromium. Vrai `getUserMedia` et véritable analyseur Web Audio ; vérification du changement de rendu du visage, puis de `readyState === 'ended'` après coupure. Test du refus d’autorisation et du retour aux poses manuelles. Aucun micro physique utilisé.
- **Cycle de vie** : tests avec événements Web Speech contrôlés (démarrage, repères, fin, échec, annulation et événement tardif). Un micro accordé après annulation est fermé ; ni la parole ni l’écoute ne reprennent automatiquement au retour sur l’onglet. Coupure vérifiée pendant la remise à zéro, un changement de modèle et un import refusé. Arrêter la lecture seule laisse en service un micro déjà activé.
- **Bureau** : les trois modules sont servis avec le type JavaScript par le gestionnaire HTTP du bureau. Les pages Réglages et Avatar ont été ouvertes dans Chromium sur la même origine : **Parler** a déclenché une lecture instrumentée côté Avatar et des poids de bouche non nuls ; **Micro** a commandé l’analyseur sur une entrée virtuelle puis libéré la piste. Une autorisation reçue après l’ordre de coupure a été ignorée. Le pont Windows natif et les fournisseurs distants ne sont pas simulés par l’atelier.

## Refaire un essai sur son poste

1. `npm test`, `npm --prefix demo ci`, `npm --prefix demo test`, `npm run demo:build`, puis `npm --prefix demo run preview`.
2. Dans **Voix et micro**, sélectionner une voix et lire « Papa fait un beau sourire ». Vérifier le son, le mouvement des lèvres et **Arrêter** en cours de lecture.
3. Activer le micro et parler, puis le couper. Vérifier la libération de l’entrée et essayer la pose manuelle **P**. Refaire l’essai en refusant l’autorisation : le message doit expliquer le refus sans bloquer l’atelier.

Les options de voix, la disponibilité des marques de mots et les autorisations dépendent du navigateur et de l’OS. Aucun test ici ne nécessite de clé ni d’appel à un fournisseur IA.
