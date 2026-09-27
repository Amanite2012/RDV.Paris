# RDV.Paris

Extension de navigateur (userscript) pour [rendez-vous.social/paris](https://rendez-vous.social/paris) :

1. **Planifier les activités selon votre agenda personnel** : chaque activité de la liste reçoit un badge
   ✅ *Libre*, ⚠️ *Serré* (moins de 30 min avec un autre rendez-vous) ou ❌ *Conflit : <votre évènement>*.
   Cochez « Mon planning » pour vos choix, puis exportez-les en `.ics` ou ajoutez-les à Google Agenda.
2. **Voir le pourcentage hommes/femmes au moment de prendre le billet** : sur la page d'une activité et
   sur la page d'achat (`/event/<id>-…/buy`), un encart affiche la répartition H/F des billets vendus,
   les places et les places restantes par genre. Le même chiffre s'affiche sur chaque carte de la liste.

## Installation

1. Installez l'extension [Tampermonkey](https://www.tampermonkey.net/) ou [Violentmonkey](https://violentmonkey.github.io/)
   (Chrome, Firefox, Edge, Safari ; Firefox Android et Kiwi Browser sur mobile).
2. Ouvrez le fichier [`dist/rdv-paris.user.js`](dist/rdv-paris.user.js) en version « Raw » : l'extension propose
   de l'installer. Sinon, copiez son contenu dans un nouveau script.
3. Allez sur https://rendez-vous.social/paris : un bouton **📅 RDV.Paris** apparaît en bas à droite.

## Connecter votre agenda

Onglet **Agenda** du panneau :

| Agenda | Où trouver le lien iCal |
| --- | --- |
| Google Agenda | Paramètres → (votre agenda) → *Intégrer l'agenda* → **Adresse secrète au format iCal** |
| Outlook / Microsoft 365 | Paramètres → Calendrier → Calendriers partagés → *Publier un calendrier* → lien **ICS** |
| Apple iCloud | Calendrier → partager → *Calendrier public* → lien `webcal://` (accepté tel quel) |

Vous pouvez ajouter plusieurs liens, ou importer un fichier `.ics`. L'agenda est relu toutes les 30 minutes.
Les évènements « toute la journée » sont ignorés par défaut, et la marge de trajet (30 min) est réglable.

## D'où vient la répartition hommes/femmes ?

La page d'achat de rendez-vous.social charge les informations de l'activité depuis l'API du site
(`…execute-api.eu-west-3.amazonaws.com/…/<id>`), qui contient :

```jsonc
{
  "rates": [
    { "name": "Tarif Regular", "gender_category": "male",   "quantity": 8, "remaining": 8 },
    { "name": "Tarif Regular", "gender_category": "female", "quantity": 8, "remaining": 7 }
  ],
  "tickets_male": 0,
  "tickets_female": 1
}
```

L'outil lit ces réponses au passage (sans requête supplémentaire) et calcule :
**♂ 0 % · ♀ 100 % (0/8 · 1/8)**, avec 8 places restantes côté hommes et 7 côté femmes.
Les billets vendus (`tickets_male` et `tickets_female`) ont la priorité. Sinon, ils sont déduits de `quantity - remaining`.

Pour les cartes de la liste, l'outil retient l'adresse de cette API dès que vous avez ouvert une page
d'activité, puis interroge la même API pour chaque activité affichée, avec les mêmes en-têtes que le site.
Si l'API n'est pas disponible, il lit le texte de la page (« 8 hommes / 12 femmes », « Hommes : 3/10 », « ♂ 5 ♀ 7 »…).

## Outil en ligne de commande

Même logique, sans navigateur ni extension (Node.js 18 ou plus récent, aucune dépendance) :

```bash
npm run plan                                  # toutes les activités à venir à Paris
npm run plan -- --jours 7 --libres            # libres dans votre agenda, sur 7 jours
npm run plan -- --ics libres.ics              # exporter les activités libres (à importer dans votre agenda)
npm run plan -- --html rapport.html           # page récapitulative (filtre « seulement libres »)
npm run plan -- --json > activites.json       # pour vos propres scripts
npm run plan -- --agenda ~/perso.ics          # ajouter un agenda ponctuellement
```

```
Date        Heure        Activité                              Statut                   ♂ / ♀       ♂ x/cap · ♀ x/cap
mar. 29/09  19:00        RDV Comedy Club - L'Epreuve du thème  ⚠️ serré (Sport)         50% / 50%   5/12 · 5/9
mer. 30/09  19:30        Apéro 30-40 ans                       ❌ Cours d'anglais       54% / 46%   25/32 · 21/34
mar. 06/10  19:30–21:00  Soirée oenologie                      ✅ libre                 0% / 100%   0/8 · 1/8
```

**Agenda** : un ou plusieurs liens iCal (voir « Connecter votre agenda » ci-dessus) ou fichiers `.ics`, au choix :

- variable d'environnement : `export RDV_ICS="https://calendar.google.com/…/basic.ics https://…"` (séparés par des espaces ou des virgules) ;
- fichier `rdv-paris.config.json` à la racine du dépôt (ignoré par git, autre emplacement avec `RDV_CONFIG=chemin`) :

```json
{
  "agendas": ["https://calendar.google.com/calendar/ical/…/basic.ics", "~/Documents/sport.ics"],
  "margeMin": 30,
  "dureeParDefautMin": 120,
  "ignorerJourneeEntiere": true
}
```

Ces liens donnent accès à votre agenda : l'outil ne les affiche jamais en entier (seulement le nom d'hôte en cas d'erreur)
et ne les met pas en cache.

**Colonnes** : `♂ / ♀` = part des billets vendus, `x/cap` = billets vendus / places par genre (`—` s'il n'y a pas de place pour
ce genre). 🔒 = vente fermée. Une activité sans heure de fin compte pour `dureeParDefautMin` (2 h). `--libres` et `--ics`
ne retiennent que les activités libres **et** encore en vente. Un chiffre comme `26/20` n'est pas une erreur : l'activité
est surréservée.

**Données** : l'API publique du site, sans compte ni clé :

| Requête | Contenu |
| --- | --- |
| `GET https://ygejsv2vy3.execute-api.eu-west-3.amazonaws.com/events?city_id=paris` | toutes les activités à venir (pas de pagination), avec `rates`, `tickets_male`, `tickets_female` |
| `GET …/event/<id>` | détail d'une activité (mêmes champs), demandé seulement si la liste n'a pas la répartition |

Horaires : `event_datetime` (début, UTC), `time_end` (heure locale, souvent vide) + `date` + `timezone`.
Une seule requête suffit en général. Les réponses sont gardées 5 minutes dans `~/.cache/rdv-paris/` (`--frais` pour
l'ignorer). Au plus 2 requêtes simultanées, avec un User-Agent `rdv-paris-cli/…`. Aucune boucle : l'outil s'arrête après
un affichage.

## Confidentialité

- Tout reste dans votre navigateur (stockage de l'extension) : liens d'agenda, activités choisies,
  adresse de l'API. Aucun serveur tiers.
- Seuls les en-têtes non sensibles de l'API (par ex. une clé d'application) sont conservés. Un éventuel jeton
  de connexion (`Authorization`, cookies) n'est jamais enregistré.
- L'onglet **Diagnostic** produit un rapport à copier si la détection ne fonctionne pas. Il contient la
  structure des pages et des réponses de l'API (noms de champs), jamais votre agenda ni les valeurs de votre compte.

## Développement

```bash
npm run build      # assemble dist/rdv-paris.user.js depuis src/
npm test           # tests unitaires (iCal, dates en français, conflits, H/F, format de l'API, CLI)
npm run test:e2e   # test navigateur sur des pages simulées (nécessite Playwright + Chromium)
```

- `src/core.js` : logique sans DOM (lecture `.ics` avec récurrences, dates en français, conflits, export `.ics`, extraction H/F).
- `src/ui.js` : interface injectée (badges, panneau, interception des réponses de l'API).
- `src/header.js` : en-tête du userscript.
- `src/cli.js` : outil en ligne de commande (`npm run plan`).
- `test/fixtures/` : réponses réelles de l'API (`/events?city_id=paris`, `/event/1889`), données personnelles retirées.
