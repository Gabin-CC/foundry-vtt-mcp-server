# Foundry VTT MCP Server

Serveur [MCP](https://modelcontextprotocol.io) **sans navigateur** pour [Foundry VTT](https://foundryvtt.com) (v13 / v14), pensé pour le système **dnd5e**.
Chaque joueur s'y connecte avec **son propre compte Foundry** (HTTP Basic auth) et agit avec **ses droits Foundry** : un joueur ne peut modifier que ses fiches, le MJ peut tout faire.

*[English below](#english)*

---

## Pourquoi ?

Les autres ponts MCP ↔ Foundry passent par un module qui tourne **dans le navigateur du MJ** : sans onglet MJ ouvert, rien ne marche.
Ici, le serveur se connecte directement à Foundry comme le ferait un navigateur (login `/join` + socket.io). Il suffit que le monde soit lancé.

```
Claude (CLI / Desktop) ──HTTPS + Basic auth──▶ foundry-vtt-mcp-server ──socket.io──▶ Foundry VTT
                                               (même machine que Foundry)
```

## Outils

| Outil | Rôle |
|---|---|
| `world_info` | Monde, compte connecté, utilisateurs |
| `list_documents` / `get_document` | Lire acteurs, objets, journaux, scènes… (filtres, champs, sous-chemins). `list_documents` est paginé : ordre stable par `_id`, `total`, `next_cursor` / `next_offset` (`cursor` ou `offset` pour la page suivante) |
| `next_page` | Suite d'une réponse trop grosse : au lieu d'être tronquée, elle est découpée en pages JSON valides (`curseur_suivant`) |
| `create_documents` / `update_documents` / `delete_documents` | CRUD générique, y compris documents embarqués (`parent: "Actor.<id>"`). `dry_run` : aperçu avant/après champ par champ (ou liste de ce qui serait supprimé) |
| `snapshots` | Instantanés pris automatiquement avant `update_documents`, `delete_documents` et `localize_actor` (valeurs d'origine des champs modifiés, documents supprimés entiers) : `list`, `show`, `restore` (avec `dry_run` ; la restauration est elle-même annulable). Fichiers JSON dans `data/snapshots` (500 derniers, 90 jours) |
| `search_text` | Recherche plein texte (sans accents) monde + compendiums, versions FR et d'origine : UUID, document, chemin de dossier, champ, extrait |
| `find_references` | Où un document est utilisé : liens `@UUID` dans les textes, objets copiés depuis lui (`compendiumSource`), jetons, notes de carte, résultats de tables, origines d'effets |
| `audit_translation` | Audit de traduction FR (monde et/ou compendiums, traductions Babele comprises) : champs restés en anglais (nom, description, activités, effets, pages, cartes, résultats de tables, objets des acteurs) avec UUID, champ, extrait, statut et correctif (`localize_actor`) ; `mode: "coverage"` = part des entrées traduites par compendium |
| `roll_table` | Tirage sur une table (monde ou compendium, traduite) comme Foundry : formule, tirage sans remise, tables imbriquées, carte dans le chat optionnelle ; `show`, `reset` |
| `cards` | Cartes : `list`, `draw`, `deal`, `pass`, `discard`, `shuffle`, `recall` (mêmes opérations que le client Foundry) |
| `actor_sheet` | Fiche calculée : niveau, maîtrise, mods, CA estimée, PV, compétences, attaque/DD de sort, emplacements |
| `roll` | Jet de dés libre posté dans le chat (`2d20kh1+5`, `8d6`, `4d6kh3`…) |
| `check` | Test de caractéristique, sauvegarde, compétence, initiative |
| `use_item` | Lance un sort / utilise une arme ou un consommable : attaque, dégâts (critiques, montée en niveau, cantrips), soins, DD de sauvegarde, consommation d'emplacement / utilisation / quantité, carte dans le chat. Avec `targets` (UUID de jetons `Scene.x.Token.y`, nom de jeton de la scène active ou `Actor.x`) : touché/raté selon la CA, sauvegarde de chaque cible, dégâts avec résistances / immunités / vulnérabilités, soins, effets/états → **proposition** à valider |
| `apply_damage` | Applique une proposition de `use_item` (tout, un sous-ensemble de cibles, ou corrigée : `overrides` avec `multiplier`, `damage`…) ou des valeurs libres (`manual`) : PV temporaires d'abord, soins plafonnés, effets copiés sur la cible ; jetons non liés modifiés seuls |
| `rest` | Repos court / long |
| `list_packs` / `search_compendium` / `get_compendium_entry` | Compendiums, recherche en **français ou anglais** |
| `add_from_compendium` | Ajoute sorts, objets, classe (avec niveaux et PV), espèce, historique… à un acteur, ou importe dans le monde |
| `localize_actor` | Traduit les objets d'un acteur d'après leur compendium d'origine (comme la traduction d'acteur de Babele) et convertit pieds/livres en mètres/kg si l'option métrique de dnd5e est active |
| `give_loot` | Pièces et objets créés à la volée |
| `upload_file` | Envoie une image / un son (base64 ou URL HTTPS explicitement autorisée via `UPLOAD_ALLOWED_ORIGINS`) |
| `send_chat` | Message dans le chat, au nom d'un personnage, chuchotements |

### Outils de MJ (comptes MJ et assistant MJ uniquement)

| Outil | Rôle |
|---|---|
| `gm_scene` | lister les scènes, activer une scène, amener les joueurs sur une scène, régler l'obscurité |
| `gm_music` | lister les playlists, lancer / arrêter une playlist ou un morceau, régler le volume, tout arrêter |
| `gm_show` | montrer une image (fenêtre chez les joueurs), un journal / une page de journal, ou amener sur une scène ; `users` choisit les destinataires ; `preview` donne un aperçu (contenu, image, jetons, qui peut déjà lire) sans rien montrer |
| `gm_permissions` | ce que chaque joueur peut voir d'un document (niveau, titre visible, contenu lisible, modifiable ; pages d'un journal ; compendiums selon le rôle) |
| `gm_tile` | poser une image sur le plateau (tuile) |
| `gm_token` | lister, poser, déplacer, cacher, montrer, retirer des jetons |
| `gm_combat` | démarrer un combat avec les jetons de la scène, tour suivant / précédent, état, fin |
| `gm_pause` | mettre la partie en pause / la reprendre |
- `gm_check_ids` : contrôle (et corrige avec `apply`) les identifiants invalides des objets — compendiums du monde, objets du monde, fiches. Foundry v14 rejette côté navigateur tout objet dont un avancement, une activité ou un effet n'a pas un identifiant de 16 caractères alphanumériques : l'objet disparaît alors de la fiche. Les objets importés ou ajoutés par le MCP sont corrigés automatiquement.

**Connexion** : l'écran de connexion de Foundry grise les comptes déjà actifs. Le serveur relâche donc sa connexion
10 s après le dernier appel (`IDLE_SECONDS`) pour que le joueur puisse revenir dans son navigateur. Le MCP fonctionne
même quand le joueur est connecté.


Les jets peuvent être publics, `mj`, `aveugle` ou `prive`.

**Traduction FR** : si le module [`dnd5e_fr-FR`](https://foundryvtt.com/packages/dnd5e_fr-FR) est installé, les noms et descriptions des compendiums sont traduits (recherche et import).

## Limites

- L'assistant d'avancement de dnd5e (choix d'aptitudes, compétences de classe…) tourne dans le navigateur : il n'est pas exécuté. `add_from_compendium` remplit les PV de classe et les sauvegardes maîtrisées ; le reste s'ajoute explicitement.
- Les valeurs dérivées (CA, emplacements max…) sont recalculées côté serveur : bonnes pour les cas courants, approximatives pour les règles exotiques ou les effets actifs.
- Le serveur utilise le protocole interne de Foundry (comme un navigateur), pas une API officielle : une mise à jour majeure de Foundry peut nécessiter une adaptation.
- Les comptes Foundry **sans mot de passe** sont refusés.

## Installation

Sur la machine qui héberge Foundry (Node.js ≥ 20) :

```bash
sudo useradd -r -m -d /opt/foundry-vtt-mcp-server -s /usr/sbin/nologin foundrymcp
sudo git clone https://github.com/Gabin-CC/foundry-vtt-mcp-server.git /opt/foundry-vtt-mcp-server
cd /opt/foundry-vtt-mcp-server && sudo npm ci --omit=dev
sudo chown -R foundrymcp:foundrymcp /opt/foundry-vtt-mcp-server
sudo cp deploy/foundry-mcp.service /etc/systemd/system/   # éditer les variables
sudo systemctl daemon-reload && sudo systemctl enable --now foundry-mcp
```

Variables d'environnement :

| Variable | Défaut | Rôle |
|---|---|---|
| `FOUNDRY_URL` | `http://127.0.0.1:30000` | URL de Foundry vue par le serveur |
| `PORT` / `HOST` | `8808` / `127.0.0.1` | Écoute HTTP (endpoint `/mcp`, santé `/mcp-health`) |
| `TRUSTED_PROXY` | *(vide)* | IP du reverse proxy dont on croit `X-Forwarded-For` |
| `PUBLIC_URL` | *(vide)* | URL publique de Foundry, pour renvoyer l'URL des fichiers envoyés |
| `UPLOAD_ALLOWED_ORIGINS` | *(vide)* | Origines HTTPS autorisées pour `upload_file` (liste séparée par des virgules) ; vide = URL distantes désactivées, base64 toujours disponible |
| `TRANSLATION_SOURCES` | `dnd5e_fr-FR/compendium_fr` | Dossiers de traductions Babele (`module/dossier`, séparés par des virgules, par priorité). Chaque dossier contient `<id du compendium>.json`, ex. `world.sors.json` |

### Reverse proxy (HTTPS obligatoire)

Exposez **uniquement** `/mcp` en HTTPS, sans authentification côté proxy (le serveur la gère). Exemple Traefik (file provider) :

```yaml
http:
  routers:
    foundry-mcp:
      rule: "Host(`foundry.example.com`) && Path(`/mcp`)"
      entryPoints: [websecure]
      service: foundry-mcp
      tls: { certResolver: letsencrypt }
  services:
    foundry-mcp:
      loadBalancer:
        servers: [{ url: "http://127.0.0.1:8808" }]
```

Nginx :

```nginx
location = /mcp { proxy_pass http://127.0.0.1:8808; proxy_set_header X-Forwarded-For $remote_addr; proxy_buffering off; }
```

En mode OAuth, exposer **aussi** les routes `/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`, `/revoke`
et `/oauth/approve` vers le même service. Ne pas exposer `/mcp-health`, ni les autres routes.
Exemple Nginx (remplace la règle `location = /mcp` ci-dessus) :

```nginx
location ~ ^/(?:mcp|authorize|token|register|revoke|oauth/approve|\.well-known/oauth-protected-resource/mcp|\.well-known/oauth-authorization-server)$ {
    proxy_pass http://127.0.0.1:8808;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
}
```

Pour Traefik, ajouter ces chemins à la règle `Path(...)` du routeur MCP.

### Mise à jour

```bash
sudo /opt/foundry-vtt-mcp-server/scripts/update.sh
```

## Connexion depuis Claude

Le header est `Authorization: Basic base64(<nom d'utilisateur Foundry>:<mot de passe>)`.

**Claude Code** :
```bash
claude mcp add --transport http foundry https://foundry.example.com/mcp \
  --header "Authorization: Basic $(printf 'MonPseudo:MonMotDePasse' | base64)"
```

**Claude Desktop** (`claude_desktop_config.json`, via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)) :
```json
{ "mcpServers": { "foundry": { "command": "npx", "args": ["-y", "mcp-remote", "https://foundry.example.com/mcp",
  "--header", "Authorization: Basic <base64>"] } } }
```

Puis : *« Montre-moi la fiche de mon perso »*, *« Je lance Boule de feu au niveau 4 sur les gobelins »*, *« Donne 50 po et une potion de guérison à Tum »*…

## Connexion depuis ChatGPT (OAuth, plusieurs joueurs)

OAuth est **optionnel**, en complément du Basic existant. Chaque joueur autorise ChatGPT avec son
propre compte Foundry : ses droits restent contrôlés par Foundry. Aucun compte MJ partagé n'est créé.

### 1. Créer une clé de chiffrement sur le serveur

```bash
sudo install -d -m 700 -o foundrymcp -g foundrymcp /etc/foundry-mcp
openssl rand -hex 32 | sudo tee /etc/foundry-mcp/oauth.key >/dev/null
sudo chown foundrymcp:foundrymcp /etc/foundry-mcp/oauth.key
sudo chmod 600 /etc/foundry-mcp/oauth.key
```

**Conserver cette clé en lieu sûr** : elle protège les mots de passe Foundry chiffrés nécessaires
aux reconnexions. Ne jamais l'ajouter à Git. En cas de perte de la clé, il faudra supprimer
l'ancien état OAuth et demander à tous les joueurs de reconnecter ChatGPT.

### 2. Activer OAuth dans le service systemd

Ajouter dans la section `[Service]` de `foundry-mcp.service` :

```ini
Environment=OAUTH_ENABLED=1
Environment=OAUTH_MCP_URL=https://foundry.example.com/mcp
Environment=OAUTH_KEY_FILE=/etc/foundry-mcp/oauth.key
```

Remplacer l'URL par l'adresse **publique exacte** de votre `/mcp`. Redémarrer :

```bash
sudo systemctl daemon-reload
sudo systemctl restart foundry-mcp
sudo journalctl -u foundry-mcp -n 30 --no-pager
```

Variables optionnelles :

| Variable | Défaut | Rôle |
|---|---|---|
| `OAUTH_ENABLED` | `0` | Activer OAuth seulement avec `1` |
| `OAUTH_MCP_URL` | *(obligatoire si activé)* | URL HTTPS publique se terminant par `/mcp` |
| `OAUTH_KEY_FILE` | *(obligatoire si activé, ou `OAUTH_ENCRYPTION_KEY`)* | Fichier contenant 64 caractères hexadécimaux |
| `OAUTH_STATE_PATH` | `data/oauth-state.json` | Clients, jetons hachés et identifiants Foundry chiffrés (fichier `0600`) |
| `OAUTH_REDIRECT_ORIGINS` | `https://chatgpt.com` | Origines de retour OAuth autorisées, séparées par des virgules |

### 3. Connecter ChatGPT

Dans les **Plugins ChatGPT**, choisir *Ajouter un serveur MCP personnalisé*, l'URL de `/mcp`,
et l'authentification **OAuth** (enregistrement dynamique du client / DCR). Le serveur publie :

- `/.well-known/oauth-protected-resource/mcp` : ressource protégée ;
- `/.well-known/oauth-authorization-server` : découverte OAuth ;
- `/register`, `/authorize`, `/token`, `/revoke` : flux OAuth gérés par le SDK MCP.

ChatGPT ouvre alors une page de connexion Foundry. Après validation, les appels MCP portent un
jeton `Bearer` associé au joueur. Les jetons d'accès expirent au bout d'une heure, les jetons
de renouvellement au bout de 30 jours (avec rotation). Le stockage survit aux redémarrages
si la clé et le fichier d'état sont conservés. Le serveur chiffre les identifiants Foundry
au repos ; aucun mot de passe n'est inclus dans un jeton. En cas de changement du mot de passe
Foundry, il faut reconnecter le compte OAuth.

**Attention** : la création d'un MCP personnalisé dépend des fonctionnalités autorisées par
le compte / l'espace de travail ChatGPT. Ne désactivez pas l'authentification sur la route `/mcp`.

### 4. Vérifier localement

```bash
npm run check
```

Les tests simulent deux joueurs, la découverte, le code PKCE, les jetons, leur renouvellement,
la persistance chiffrée et les refus d'authentification. Ils ne remplacent pas un test avec
un véritable monde Foundry et une connexion ChatGPT.

## Sécurité

- Authentification déléguée à Foundry (mêmes mots de passe, mêmes permissions).
- Anti brute-force : 10 échecs / 15 min / IP → 429.
- Sessions Foundry libérées par défaut après 10 s d'inactivité (clé = hash utilisateur + mot de passe).
- OAuth facultatif : compte Foundry de chaque joueur, PKCE, renouvellement et stockage chiffré des identifiants.
- Le serveur ne lit jamais les fichiers de Foundry : tout passe par le protocole client.
- L'API MCP écoute uniquement sur `127.0.0.1` par défaut (`HOST`) : pour un proxy distant, configurer une adresse de réseau privé et un pare-feu adapté. Ne jamais exposer le port MCP en HTTP public.
- `upload_file` refuse par défaut les téléchargements distants. Pour autoriser des images externes : définir `UPLOAD_ALLOWED_ORIGINS=https://cdn.example.com,https://media.example.org` ; seules les URL HTTPS de ces origines sont acceptées, avec filtrage des adresses privées et limite de 20 Mio. Les SVG sont refusés.

## Tests

```bash
ADMIN_PASSWORD='mdp admin Foundry' node scripts/test-tools.mjs MonPseudo '[["actor_sheet",{"actor":"Tum"}]]'
```
(utilise le mot de passe administrateur pour se connecter « en tant que » un utilisateur ; variante sans mot de passe
administrateur : `FOUNDRY_AUTH=<base64 utilisateur:mot de passe> node scripts/test-tools.mjs - @appels.json`. Dans une
suite d'appels, `"@last.chemin"` reprend une valeur de la réponse précédente, ex. `["apply_damage",{"proposal":"@last.proposition"}]`)

Variables supplémentaires : `MAX_OUT` (taille max d'une réponse avant découpage, défaut 60000), `SNAPSHOT_DIR`,
`SNAPSHOT_KEEP`, `SNAPSHOT_DAYS` (instantanés de restauration).

---

## English

Headless [MCP](https://modelcontextprotocol.io) server for Foundry VTT v13/v14 (dnd5e-focused). **No browser and no Foundry module needed**: the server logs in to Foundry like a web client (`/join` + socket.io). Each user authenticates with **their own Foundry username and password** via HTTP Basic auth and acts with their own Foundry permissions.

Tools: generic document CRUD (incl. embedded documents), computed character sheet, dice rolls and checks posted to chat, `use_item` (spell/weapon/consumable: attack, damage incl. crits/upcasting/cantrip scaling, healing, save DC, slot/uses/quantity consumption, chat card), short/long rest, compendium search (French or English names when the `dnd5e_fr-FR` Babele translations are installed), `add_from_compendium` (spells, items, class with levels/HP, species, background…), `localize_actor` (re-apply Babele translations and metric units to an existing actor), loot, file upload, chat messages. Also: stable pagination (`list_documents` cursors, oversized answers split into valid JSON pages + `next_page`), `dry_run` before/after previews and server-side restore snapshots (`snapshots`), world + compendium full-text search (`search_text`) and reverse references (`find_references`), translation audit / coverage (`audit_translation`), roll tables (`roll_table`) and cards (`cards`), targeted `use_item` with a validation step (`apply_damage`), GM sharing with recipients and preview (`gm_show`) and permission checks (`gm_permissions`).

Limitations: the dnd5e advancement workflow runs client-side and is not executed; derived values are recomputed server-side (good for common cases); relies on Foundry's internal client protocol, so major Foundry updates may require changes; users without a password are rejected.

Install: see the commands above (Node ≥ 20, systemd unit in `deploy/`), expose only `/mcp` over HTTPS through your reverse proxy, then add it to Claude with an `Authorization: Basic …` header.
Optional OAuth 2.1 support for ChatGPT is documented above; each player connects with their own Foundry credentials. The existing Basic authentication remains available.

### Security-hardening notes (phase 1)

- The MCP HTTP server now binds to **`127.0.0.1` by default**, including in the supplied systemd unit. Keep TLS termination at the reverse proxy. If your proxy runs on another host or container, explicitly set `HOST` to the appropriate private interface and firewall the port.
- Remote URLs for `upload_file` are **disabled by default**. Base64 uploads continue working. To enable a specific asset CDN, set `UPLOAD_ALLOWED_ORIGINS=https://assets.example.com` (comma-separated HTTPS origins; an origin includes its port, if non-default). Redirect destinations must also be allowlisted. Private and reserved IP addresses are blocked after DNS lookup and on connection; downloads have time and 20 MiB limits.
- File uploads reject path traversal, unknown formats, and **SVG**; recognized formats are PNG, JPEG, WebP, GIF, MP3, OGG, WAV, WebM, MP4 and PDF. A basic file-signature check is performed. This is not an antivirus or content-disarm system.
- Property overrides and active-effect updates reject prototype-related keys. This prevents a malicious document key from modifying the Node.js process-wide object prototype.
- Existing `upload_file` clients that used arbitrary URLs must either switch to base64 or configure explicitly trusted CDN origins. The current release remains French-first; a versioned English API migration is planned separately.

## Licence

MIT — not affiliated with Foundry Gaming LLC or Anthropic.
