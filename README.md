# RDV.Paris

Choisir ses activités [rendez-vous.social/paris](https://rendez-vous.social/paris) selon son agenda, avec la
répartition hommes/femmes. Trois façons de s'en servir :

| | Pour qui | Où |
| --- | --- | --- |
| **Liste H/F** | le pourcentage hommes/femmes de chaque activité à Paris et en Île-de-France | `npm run hf` |
| **Site web** | plusieurs personnes : chacune se connecte, branche ses agendas, choisit ses activités et reçoit des alertes | [`web/`](web/), section « Site web » |
| **Outil en ligne de commande** | usage personnel, sans navigateur | [`src/cli.js`](src/cli.js), `npm run plan` |
| **Userscript** | badges directement sur rendez-vous.social | [`dist/rdv-paris.user.js`](dist/rdv-paris.user.js) |

## Liste hommes/femmes

```bash
npm run hf                  # toutes les activités à venir, Paris et Île-de-France, triées par date
npm run hf -- --dept 75     # seulement Paris (plusieurs : --dept 92,93)
npm run hf -- --json        # pour vos propres scripts
```

```
Date        Heure  CP     Activité                                      ♂ %    ♀ %  Inscrits
lun. 28/09  19:30  75019  Apéro Jeux de Société                        65 %   35 %  22 H · 12 F
mer. 30/09  19:30  92130  Soirée Loup-Garou                            67 %   33 %  14 H · 7 F
dim. 04/10  09:00  77300  Rando Chill                                  43 %   57 %  3 H · 4 F
```

Une seule requête : pour l'API, `city_id=paris` (« Paris & Banlieue ») couvre les 8 départements d'Île-de-France.
Le pourcentage porte sur les billets vendus (`tickets_male` / `tickets_female`) : regardez la colonne *Inscrits*
avant de conclure (100 % avec une seule personne ne dit pas grand-chose). Réponse gardée 5 minutes en cache
(`--frais` pour l'ignorer).

## Site web

- **Connexion** avec Google, ou par lien envoyé par e-mail (pas de mot de passe).
- **Agendas** : Google Agenda (lecture seule) et liens iCal (Outlook, Apple, Google…), plusieurs à la fois.
- **Activités** : pour chacune, *Libre*, *Serré* (moins de 30 min avec un autre évènement) ou *Conflit* avec le nom
  de l'évènement, la part hommes/femmes, les places vendues et les places restantes pour vous. Filtres par
  période, « libres », « places pour moi » et recherche.
- **Mon planning** : « Choisir » une activité l'ajoute à votre planning (cela ne réserve pas : « Réserver » ouvre la
  page d'achat du site). Téléchargement `.ics`, lien d'abonnement pour votre agenda, ajout à Google Agenda.
- **E-mails** : alertes sur vos activités choisies (nouveau conflit avec votre agenda, dernières places pour
  vous, complet, vente fermée, activité disparue), rappel la veille, nouvelles activités libres (facultatif).
  Un seul e-mail par vérification (toutes les 30 min), chaque alerte n'est envoyée qu'une fois, lien de
  désinscription dans chaque message.

### Essayer en local

```bash
npm install
npm run dev        # http://localhost:3100 : connexion sans vérification, e-mails affichés dans la console
```

### Configuration

Tout passe par des variables d'environnement : voir [`web/.env.example`](web/.env.example).

```bash
cp web/.env.example .env      # puis complétez
node --env-file=.env web/server.js
```

Sans Google ni e-mail configurés, personne ne peut se connecter (sauf `DEV_LOGIN=1`, réservé à `localhost`).

**Connexion Google et Google Agenda** ([Google Cloud Console](https://console.cloud.google.com/)) :

1. Créez un projet, puis activez **Google Calendar API** (API et services → Bibliothèque).
2. *Écran de consentement OAuth* : type **Externe**, nom de l'application, e-mail d'assistance, lien vers
   `<BASE_URL>/confidentialite`. Champs d'application : `openid`, `email`, `profile`,
   `https://www.googleapis.com/auth/calendar.readonly`.
3. *Identifiants* → **ID client OAuth** → *Application Web*. URI de redirection autorisé :
   `<BASE_URL>/auth/google/callback` (et `http://localhost:3100/auth/google/callback` pour les essais).
4. Copiez l'ID et le code secret dans `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET`.

En mode **Test** (le défaut), seules les adresses ajoutées comme *utilisateurs test* (100 au maximum) peuvent se
connecter, et Google coupe l'accès à l'agenda au bout de 7 jours (il faut alors cliquer sur « Reconnecter »).
Pour ouvrir le site à tous, publiez l'application : l'accès à l'agenda (`calendar.readonly`) passe alors par une
vérification de Google (domaine vérifié, page de confidentialité, courte vidéo de démonstration). La connexion
seule (`openid email profile`) n'en demande pas. Sans Google, chacun peut toujours coller l'*adresse secrète au
format iCal* de son Google Agenda.

**E-mails** : n'importe quel serveur SMTP via `SMTP_URL`. Avec Gmail, créez un
[mot de passe d'application](https://myaccount.google.com/apppasswords) (validation en deux étapes requise) :
`SMTP_URL=smtps://vous%40gmail.com:motdepasse@smtp.gmail.com:465`, environ 500 e-mails par jour. Pour un domaine
à vous, un service comme Brevo ou Resend délivre mieux (SPF/DKIM). Réglages → « Envoyer un e-mail de test » vérifie
la configuration.

### Mise en ligne

Le site doit être servi en **HTTPS** avec un nom de domaine : Google refuse une adresse IP comme adresse de retour.

```bash
docker build -t rdv-paris .
docker run -d --name rdv-paris --restart unless-stopped --env-file .env \
  -e HOST=0.0.0.0 -v rdv-paris-data:/data -p 127.0.0.1:3100:3100 rdv-paris
```

Derrière nginx :

```nginx
server {
    server_name rdv.example.fr;
    # listen 443 ssl; + certificats (certbot)
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

Données : `DATA_DIR/db.json` (comptes, réglages, choix) et `DATA_DIR/secret.key` (si `APP_SECRET` n'est pas
défini). Sauvegardez les deux : sans la clé, les liens d'agenda et les accès Google ne sont plus lisibles.

### Sécurité et respect du site

- Liens iCal et jetons Google **chiffrés** (AES-256-GCM) ; jamais renvoyés au navigateur ni écrits dans les journaux.
- Les liens iCal ne peuvent pas viser le réseau interne du serveur (adresses privées, `localhost`, métadonnées
  du cloud), y compris après une redirection ou une résolution DNS.
- Sessions en cookie `HttpOnly`/`SameSite=Lax` (`Secure` en HTTPS). Toute modification exige un en-tête propre à
  l'application, ce qui bloque les requêtes venues d'autres sites. En-têtes CSP stricts pour les scripts.
- Liens de connexion par e-mail valables 20 minutes, à usage unique, avec une page de confirmation (les
  antivirus de messagerie qui ouvrent les liens ne consomment pas la connexion) et une limite de tentatives.
- « Supprimer mon compte » efface tout et révoque l'accès Google.
- rendez-vous.social : **une** lecture de la liste des activités pour tous les utilisateurs, gardée 5 minutes.

## Userscript

Extension de navigateur pour [rendez-vous.social/paris](https://rendez-vous.social/paris) :

1. **Planifier les activités selon votre agenda personnel** : chaque activité de la liste reçoit un badge
   ✅ *Libre*, ⚠️ *Serré* (moins de 30 min avec un autre rendez-vous) ou ❌ *Conflit : <votre évènement>*.
   Cochez « Mon planning » pour vos choix, puis exportez-les en `.ics` ou ajoutez-les à Google Agenda.
2. **Voir le pourcentage hommes/femmes au moment de prendre le billet** : sur la page d'une activité et
   sur la page d'achat (`/event/<id>-…/buy`), un encart affiche la répartition H/F des billets vendus,
   les places et les places restantes par genre. Le même chiffre s'affiche sur chaque carte de la liste.

### Installation

1. Installez l'extension [Tampermonkey](https://www.tampermonkey.net/) ou [Violentmonkey](https://violentmonkey.github.io/)
   (Chrome, Firefox, Edge, Safari ; Firefox Android et Kiwi Browser sur mobile).
2. Ouvrez le fichier [`dist/rdv-paris.user.js`](dist/rdv-paris.user.js) en version « Raw » : l'extension propose
   de l'installer. Sinon, copiez son contenu dans un nouveau script.
3. Allez sur https://rendez-vous.social/paris : un bouton **📅 RDV.Paris** apparaît en bas à droite.

### Connecter votre agenda

Onglet **Agenda** du panneau :

| Agenda | Où trouver le lien iCal |
| --- | --- |
| Google Agenda | Paramètres → (votre agenda) → *Intégrer l'agenda* → **Adresse secrète au format iCal** |
| Outlook / Microsoft 365 | Paramètres → Calendrier → Calendriers partagés → *Publier un calendrier* → lien **ICS** |
| Apple iCloud | Calendrier → partager → *Calendrier public* → lien `webcal://` (accepté tel quel) |

Vous pouvez ajouter plusieurs liens, ou importer un fichier `.ics`. L'agenda est relu toutes les 30 minutes.
Les évènements « toute la journée » sont ignorés par défaut, et la marge de trajet (30 min) est réglable.

### D'où vient la répartition hommes/femmes ?

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

### Confidentialité (userscript)

- Tout reste dans votre navigateur (stockage de l'extension) : liens d'agenda, activités choisies,
  adresse de l'API. Aucun serveur tiers.
- Seuls les en-têtes non sensibles de l'API (par ex. une clé d'application) sont conservés. Un éventuel jeton
  de connexion (`Authorization`, cookies) n'est jamais enregistré.
- L'onglet **Diagnostic** produit un rapport à copier si la détection ne fonctionne pas. Il contient la
  structure des pages et des réponses de l'API (noms de champs), jamais votre agenda ni les valeurs de votre compte.

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

## Développement

```bash
npm install
npm test           # tests unitaires : iCal, conflits, H/F, format de l'API, CLI, site (parcours complet sur une fausse API)
npm run dev        # site en local
npm run build      # assemble dist/rdv-paris.user.js depuis src/
npm run test:e2e   # userscript sur des pages simulées (nécessite Playwright + Chromium)
```

- `src/core.js` : logique sans DOM (lecture `.ics` avec récurrences, dates en français, conflits, export `.ics`, extraction H/F).
- `src/rvs.js` : accès à l'API de rendez-vous.social (cache, limite de requêtes), partagé par la CLI et le site.
- `src/cli.js` : outil en ligne de commande (`npm run plan`).
- `src/ui.js`, `src/header.js` : interface et en-tête du userscript.
- `web/server.js` : serveur HTTP (connexion, API, flux iCal) ; `web/google.js` (OAuth, Google Agenda),
  `web/calendars.js` (agendas, protection SSRF), `web/notify.js` (e-mails), `web/store.js` (données),
  `web/public/` (interface).
- `test/fixtures/` : réponses réelles de l'API (`/events?city_id=paris`, `/event/1889`), données personnelles retirées.
