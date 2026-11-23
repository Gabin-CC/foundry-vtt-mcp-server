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
| `list_documents` / `get_document` | Lire acteurs, objets, journaux, scènes… (filtres, champs, sous-chemins) |
| `create_documents` / `update_documents` / `delete_documents` | CRUD générique, y compris documents embarqués (`parent: "Actor.<id>"`) |
| `actor_sheet` | Fiche calculée : niveau, maîtrise, mods, CA estimée, PV, compétences, attaque/DD de sort, emplacements |
| `roll` | Jet de dés libre posté dans le chat (`2d20kh1+5`, `8d6`, `4d6kh3`…) |
| `check` | Test de caractéristique, sauvegarde, compétence, initiative |
| `use_item` | Lance un sort / utilise une arme ou un consommable : attaque, dégâts (critiques, montée en niveau, cantrips), soins, DD de sauvegarde, consommation d'emplacement / utilisation / quantité, carte dans le chat |
| `rest` | Repos court / long |
| `list_packs` / `search_compendium` / `get_compendium_entry` | Compendiums, recherche en **français ou anglais** |
| `add_from_compendium` | Ajoute sorts, objets, classe (avec niveaux et PV), espèce, historique… à un acteur, ou importe dans le monde |
| `localize_actor` | Traduit les objets d'un acteur d'après leur compendium d'origine (comme la traduction d'acteur de Babele) et convertit pieds/livres en mètres/kg si l'option métrique de dnd5e est active |
| `give_loot` | Pièces et objets créés à la volée |
| `upload_file` | Envoie une image / un son (URL ou base64) |
| `send_chat` | Message dans le chat, au nom d'un personnage, chuchotements |

### Outils de MJ (comptes MJ et assistant MJ uniquement)

| Outil | Rôle |
|---|---|
| `gm_scene` | lister les scènes, activer une scène, amener les joueurs sur une scène, régler l'obscurité |
| `gm_music` | lister les playlists, lancer / arrêter une playlist ou un morceau, régler le volume, tout arrêter |
| `gm_show` | montrer une image (fenêtre chez les joueurs) ou un journal / une page de journal |
| `gm_tile` | poser une image sur le plateau (tuile) |
| `gm_token` | lister, poser, déplacer, cacher, montrer, retirer des jetons |
| `gm_combat` | démarrer un combat avec les jetons de la scène, tour suivant / précédent, état, fin |
| `gm_pause` | mettre la partie en pause / la reprendre |

**Une session par compte** : Foundry n'accepte qu'une connexion par compte. Le serveur relâche sa connexion
10 s après le dernier appel (`IDLE_SECONDS`) ; si le compte est déjà connecté dans un navigateur, l'appel renvoie
une erreur 409 explicite. Pour utiliser le MCP pendant une partie, utiliser un compte Foundry dédié au MCP.


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
| `PORT` / `HOST` | `8808` / `0.0.0.0` | Écoute HTTP (endpoint `/mcp`, santé `/mcp-health`) |
| `TRUSTED_PROXY` | *(vide)* | IP du reverse proxy dont on croit `X-Forwarded-For` |
| `PUBLIC_URL` | *(vide)* | URL publique de Foundry, pour renvoyer l'URL des fichiers envoyés |
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

## Sécurité

- Authentification déléguée à Foundry (mêmes mots de passe, mêmes permissions).
- Anti brute-force : 10 échecs / 15 min / IP → 429.
- Sessions Foundry en cache 30 min (clé = hash utilisateur + mot de passe).
- Le serveur ne lit jamais les fichiers de Foundry : tout passe par le protocole client.

## Tests

```bash
ADMIN_PASSWORD='mdp admin Foundry' node scripts/test-tools.mjs MonPseudo '[["actor_sheet",{"actor":"Tum"}]]'
```
(utilise le mot de passe administrateur pour se connecter « en tant que » un utilisateur)

---

## English

Headless [MCP](https://modelcontextprotocol.io) server for Foundry VTT v13/v14 (dnd5e-focused). **No browser and no Foundry module needed**: the server logs in to Foundry like a web client (`/join` + socket.io). Each user authenticates with **their own Foundry username and password** via HTTP Basic auth and acts with their own Foundry permissions.

Tools: generic document CRUD (incl. embedded documents), computed character sheet, dice rolls and checks posted to chat, `use_item` (spell/weapon/consumable: attack, damage incl. crits/upcasting/cantrip scaling, healing, save DC, slot/uses/quantity consumption, chat card), short/long rest, compendium search (French or English names when the `dnd5e_fr-FR` Babele translations are installed), `add_from_compendium` (spells, items, class with levels/HP, species, background…), `localize_actor` (re-apply Babele translations and metric units to an existing actor), loot, file upload, chat messages.

Limitations: the dnd5e advancement workflow runs client-side and is not executed; derived values are recomputed server-side (good for common cases); relies on Foundry's internal client protocol, so major Foundry updates may require changes; users without a password are rejected.

Install: see the commands above (Node ≥ 20, systemd unit in `deploy/`), expose only `/mcp` over HTTPS through your reverse proxy, then add it to Claude with an `Authorization: Basic …` header.

## Licence

MIT — not affiliated with Foundry Gaming LLC or Anthropic.
