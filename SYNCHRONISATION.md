# Préparation de la synchronisation

La version 4 reste locale, conformément au choix de préparer la synchronisation et de sélectionner le service plus tard. Aucun compte, serveur ou envoi d’inventaire n’est configuré.

## Contrat de données

`inventory-core.js` contient les règles et la validation du format de sauvegarde 4. Les identifiants de produits, mouvements et commandes sont stables. `datasetId` identifie l’inventaire ; `revision` identifie son état local. Importer une sauvegarde conserve les identifiants. Les archives et annulations sont explicites et gardent l’historique.

`inventory.js` centralise les écritures dans `commitData` : une transaction IndexedDB sur produits, mouvements, commandes, métadonnées et copie de récupération. La révision de la base est vérifiée dans cette même transaction. Une écriture concurrente est refusée, puis les vues sont rechargées. Une fiche ouverte garde également la révision du produit pour détecter une modification entre son ouverture et sa soumission.

`BroadcastChannel` ne communique qu’entre les fenêtres du même navigateur et de la même origine. Ce mécanisme n’est pas une synchronisation entre téléphones.

## Travail au choix du service

Ajouter un adaptateur authentifié avec stockage privé par compte, un journal d’opérations envoyées / acquittées, des identifiants de requête idempotents et une stratégie de conflits. Les réceptions et mouvements doivent être fusionnés comme opérations, jamais par simple remplacement du dernier stock reçu. Les révisions locales ne sont pas des horloges distribuées.

Valider la gestion des comptes, la restauration, la suppression, le mode hors connexion, les quotas et les photos avant activation. Prévoir des tests à deux appareils, des reprises après coupure et le cas où une même commande est réceptionnée simultanément.

Ne pas placer d’inventaire privé ni de clé secrète dans le dépôt public GitHub Pages. Une simple URL de serveur ou un bouton « synchroniser » sans cette infrastructure ne constitue pas une synchronisation fonctionnelle.

## Sources Android

- Installation PWA : https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt
- Intent Android et repli web : https://developer.chrome.com/docs/android/intents
- Paquet Business déclaré par Amazon : https://business.amazon.ca/.well-known/assetlinks.json
- Association iOS préservée : https://business.amazon.ca/.well-known/apple-app-site-association
