# Foundry VTT MCP Server — Guide français

> Ce guide français est conservé pendant la migration. La [documentation anglaise principale](../README.md) est la référence pour les fonctionnalités et les instructions de sécurité les plus récentes, notamment OAuth.

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
| `list_documents` / `get_document` | Lire acteurs, objets, journaux, scènes… (filtres, champs, sous-chemins). `list_documents` est paginé : ordre stable par `_id`, `total`, `next_cursor` / `next_offset` (`cursor` ou `offset` pour la page suivante). Pour `ChatMessage`, `since_timestamp` (ms Unix inclusifs) active l'ordre `timestamp`, puis `_id`, et ajoute `latest_timestamp` ; la classe `FoundrySession` entretient un cache du chat alimenté par les événements socket, avec une resynchronisation complète toutes les 15 s par défaut (`CHAT_CACHE_MAX_AGE_MS`). |
| `next_page` | Suite d'une réponse trop grosse : au lieu d'être tronquée, elle est découpée en pages JSON valides (`curseur_suivant`) |
| `create_documents` / `update_documents` / `delete_documents` | CRUD générique, y compris documents embarqués (`parent: "Actor.<id>"`). `dry_run` : aperçu avant/après champ par champ (ou liste de ce qui serait supprimé) |
| `snapshots` | Instantanés pris automatiquement avant `update_documents`, `delete_documents` et `localize_actor` (valeurs d'origine des champs modifiés, documents supprimés entiers) : `list`, `show`, `restore` (avec `dry_run` ; la restauration est elle-même annulable). Fichiers JSON dans `data/snapshots` (500 derniers, 90 jours) |
| `search_text` | Recherche plein texte (sans accents) monde + compendiums, versions FR et d'origine : UUID, document, chemin de dossier, champ, extrait |
| `find_references` | Où un document est utilisé : liens `@UUID` dans les textes, objets copiés depuis lui (`compendiumSource`), jetons, notes de carte, résultats de tables, origines d'effets |
| `audit_translation` | Audit de traduction FR (monde et/ou compendiums, traductions Babele comprises) : champs restés en anglais (nom, description, activités, effets, pages, cartes, résultats de tables, objets des acteurs) avec UUID, champ, extrait, statut et correctif (`localize_actor`) ; `mode: "coverage"` = part des entrées traduites par compendium |
| `roll_table` | Tirage sur une table (monde ou compendium, traduite) comme Foundry : formule, tirage sans remise, tables imbriquées, carte dans le chat optionnelle ; `show`, `reset` |
| `cards` | Cartes : `list`, `draw`, `deal`, `pass`, `discard`, `shuffle`, `recall` (mêmes opérations que le client Foundry) |
| `actor_sheet` | Fiche calculée : niveau, maîtrise, mods, CA estimée, PV, compétences, attaque/DD de sort, emplacements |
| `validate_actor` | Audit D&D 2024 **en lecture seule** : niveaux et classes, provenance des règles, limites de sorts propres à chaque classe et conflits d'équipement. Distingue erreurs établies, avertissements et points non vérifiables |
| `advancement_blueprint` | Lit les choix de progression réellement enregistrés sur une fiche à classe unique, la source exacte de la classe et les caractéristiques avant progression de classe (lecture seule) |
| `advance` avec `replay_from` | Rejoue automatiquement ces choix sur une autre fiche avec la même classe ; demande uniquement les choix introuvables dans la source |
| `progress_actor` | Fait progresser une **fiche existante** D&D 2024 à classe unique : simulation sans écriture par défaut, choix explicites, sauvegarde avant application et restauration contrôlée |
| `multiclass_actor` | Ajoute une classe secondaire ou fait monter une classe d'une **fiche multiclasse D&D 2024** : prérequis de caractéristiques, un niveau par appel, simulation, choix et restauration |
| `edit_actor` | Modifie l'équipement porté et les sorts de classe préparés d'une fiche existante : simulation, contrôles D&D 2024, instantané et restauration |
| `build_actor` | Construit une nouvelle fiche D&D 2024 sans modèle depuis les compendiums de classe/espèce/historique, niveau et caractéristiques ; **simulation par défaut**, choix obligatoires avant `apply: true` |
| `rebuild_actor` | Reconstruit dans une nouvelle fiche classe + espèce + historique par avancement, puis réconcilie les sorts, objets et récompenses ; **simulation par défaut**, écriture seulement avec `apply: true` |
| `compare_actors` | Compare deux fiches calculées et détaille les différences de caractéristiques, PV, sorts, aptitudes et inventaire (lecture seule) |
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
| `gm_check_ids` | contrôle (et corrige avec `apply`) les identifiants invalides des objets — compendiums du monde, objets du monde, fiches |
| `gm_sync_items` | synchronise les objets d'une fiche avec leur compendium d'origine : ajoute les effets, activités et avancements manquants (simulation par défaut, `apply` écrit, instantané de restauration) |
| `gm_patch_items` | applique les correctifs de données de compendium (Lame retentissante, Lame des flammes vertes : attaque d'arme) à un acteur ou à un compendium |
- `gm_check_ids` : contrôle (et corrige avec `apply`) les identifiants invalides des objets — compendiums du monde, objets du monde, fiches. Foundry v14 rejette côté navigateur tout objet dont un avancement, une activité ou un effet n'a pas un identifiant de 16 caractères alphanumériques : l'objet disparaît alors de la fiche. Les objets importés ou ajoutés par le MCP sont corrigés automatiquement (`create_documents` inclus).
- `gm_sync_items` : pour chaque objet d'une fiche, compare avec `_stats.compendiumSource` et signale (ou ajoute, `apply`) les effets, activités et avancements manquants. `item`, `only` et `pack` limitent la portée ; un instantané de restauration est gardé.
- `gm_patch_items` : applique les correctifs de structure de `src/patches.mjs` (entrées de compendium incomplètes) à un acteur (`actor`), à tous, ou à un compendium du monde (`pack`). Les mêmes correctifs sont appliqués automatiquement à la création d'un objet (`create_documents`, `add_from_compendium`, `advance`).

- Les objets créés par le MCP sont assainis (identifiants de 16 caractères, références d'effets re-pointées) et les entrées de compendium à structure incomplète sont corrigées (`src/patches.mjs`) : Lame retentissante et Lame des flammes vertes reçoivent leur attaque d'arme au lieu de dégâts « on hit » sans jet.
- `use_item` gère les attaques classées « weapon » (True Strike, Shillelagh, cantrips d'arme) : bonus et dégâts de l'arme équipée, formules `max(…)`/`floor(…)`/divisions.
- `search_compendium` et `add_from_compendium` privilégient les entrées 2024 (option `rules: "2024"` pour forcer la version 2024 d'un compendium).

**Connexion** : l'écran de connexion de Foundry grise les comptes déjà actifs. Le serveur relâche donc sa connexion
10 s après le dernier appel (`IDLE_SECONDS`) pour que le joueur puisse revenir dans son navigateur. Le MCP fonctionne
même quand le joueur est connecté.


Les jets peuvent être publics, `mj`, `aveugle` ou `prive`.

**Traduction FR** : si le module [`dnd5e_fr-FR`](https://foundryvtt.com/packages/dnd5e_fr-FR) est installé, les noms et descriptions des compendiums sont traduits (recherche et import).

### Construire un personnage D&D 2024 sans modèle

L'outil `build_actor` crée une fiche neuve, tandis que `rebuild_actor` (ci-dessous) reproduit une fiche existante.

**Choix de maîtrises D&D 2024 :** les jokers `weapon:*` (maîtrise d'arme) et `tool:game:*` (jeux) sont développés à partir des objets de base du compendium installé `dnd5e.equipment24`. La simulation propose de vrais identifiants, par exemple `weapon:mar:longsword` et `tool:game:dice` : il faut fournir ces valeurs, **pas les jokers**. Les maîtrises d'armes sont limitées aux catégories d'armes déjà maîtrisées et enregistrées séparément des compétences d'armes. Un choix invalide ou répété bloque l'application (`pret: false`). Sans le compendium officiel, la simulation reste bloquée jusqu'à résolution des choix.

1. Fournir un nom unique, les UUID de compendiums de **classe, espèce et historique 2024**, le niveau (1–20) et les six caractéristiques **avant les augmentations de l'historique**. L'agent peut retrouver les UUID par `search_compendium`. Un champ absent est signalé dans `parametres_requis` ; aucun élément n'est deviné.
2. La simulation (par défaut) liste les `choix_requis` : dons, sous-classe, maîtrises, équipement de départ, etc. Répéter l'appel avec `choices` jusqu'à `pret: true`.
3. Seul `apply: true` crée l'acteur, puis utilise le moteur `advance` pour rejouer classe → espèce → historique. L'armure de départ, un bouclier compatible et une arme principale sont automatiquement équipés (`auto_equip: false` désactive cette option). Une erreur d'écriture identifie l'éventuel acteur partiel ; une fiche existante n'est jamais remplacée.

Les sources doivent déclarer `system.source.rules: "2024"`. Le niveau et les caractéristiques sont contrôlés, mais **la méthode de génération des caractéristiques et toute la légalité des règles ne sont pas certifiées**. Par défaut, `spells: "none"` reporte le choix des sorts à `advance`. Le nouveau mode `spells: "selected"` demande des listes d'UUID officiels exacts dans `choices["spells:prepared"]` et, si nécessaire, `choices["spells:cantrips"]` : nombre, doublons, classe, niveau et édition sont contrôlés **avant toute création**. Seuls ces sorts sont importés et préparés. En l'absence de liste officielle installée, la création reste bloquée. L'option historique `spells: "all"` importe toute la liste accessible et ne constitue **pas** un grimoire conforme pour un Magicien ou une autre classe à sorts connus limités.

### Faire progresser une fiche existante (D&D 2024)

`progress_actor` fonctionne sur un personnage **déjà présent**, possédant une seule classe 2024. Il conserve son identifiant, ses objets et ses choix antérieurs.

1. `progress_actor({ "actor": "ID_ACTEUR", "level": 9 })` liste les changements à venir et les `choix_requis`, **sans aucune écriture**.
2. Fournir les choix manquants dans `choices`, puis répéter la simulation jusqu'à `pret: true`. Les caractéristiques, dons, aptitudes et maîtrises sont traités par le même moteur d'avancement que `advance`.
3. `apply: true` sauvegarde l'état complet utile de l'acteur et de ses objets **avant** la montée de niveau, applique les choix puis vérifie le niveau final. La réponse indique `instantane`.
4. En cas d'erreur, `snapshots` permet `show`, puis `restore` avec `dry_run: true`, enfin `restore` après vérification. Cette restauration possède à son tour un instantané d'annulation.

La restauration **refuse de remplacer les modifications ultérieures** à la montée de niveau. `advance` accepte aussi `apply: false` pour une simulation en lecture seule ; ses appels existants continuent d'appliquer par défaut. `progress_actor` reste dédié à la classe unique ; `multiclass_actor` prend en charge les classes multiples et `edit_actor` les modifications d'objets et de sorts. La baisse de niveau et la conformité complète seront traitées séparément.

### Multiclassage D&D 2024

`multiclass_actor` fonctionne sur une fiche existante, uniquement pour des classes avec une source vérifiable `system.source.rules: "2024"`. Il ajoute une nouvelle classe secondaire (`class_source` = UUID exact d'un compendium) ou augmente une classe déjà présente (`item` = identifiant embarqué). **Un seul niveau de personnage par appel**, niveau total maximum 20. Sans `apply: true`, aucune écriture.

1. Trouver la classe dans `search_compendium` puis appeler `multiclass_actor({ "actor": "ID_ACTEUR", "class_source": "Compendium.dnd5e.classes24.Item.ID_CLASSE" })`.
2. Vérifier les `prerequis` : en entrant dans une nouvelle classe, le personnage doit avoir au moins 13 dans les caractéristiques principales **de chacune de ses classes**. Guerrier : FOR *ou* DEX ; Moine, Paladin et Rôdeur : les deux caractéristiques requises. Les éditions mélangées et les classes inconnues sont refusées.
3. Fournir les `choix_requis` de l'avancement, relancer la simulation jusqu'à `pret: true`, puis confirmer avec `apply: true` : l'outil prend un instantané récupérable et vérifie le résultat. Les maîtrises secondaires sont sélectionnées selon les données officielles ; **l'équipement de départ d'une seconde classe n'est pas accordé**.
4. Pour monter l'une des classes déjà présentes, utiliser `multiclass_actor({ "actor": "ID_ACTEUR", "item": "ID_CLASSE_EMBARQUEE", "level": 2 })`, avec le niveau correspondant au prochain niveau **de cette classe**, pas au niveau total.

Les emplacements de sorts multiclasses 2024 comptent la moitié **arrondie au supérieur** des niveaux de Paladin et Rôdeur ; Pacte magique reste séparé. **Un emplacement partagé de haut niveau ne permet pas d'apprendre un sort de ce niveau** dans une classe de bas niveau.

Pour choisir les sorts de la classe qui progresse, activer `spells: "selected"` et lancer d'abord une simulation : `choix_requis` indique les sorts éligibles, vérifiés dans les listes officielles installées. Renseigner les UUID exacts des compendiums 2024 dans `choices["spells:cantrips"]` et `choices["spells:prepared"]`. Pour un **Magicien** de niveau de classe 1, fournir également **six** UUID dans `choices["spells:spellbook"]`, puis choisir les quatre sorts préparés dans ce grimoire ; deux nouveaux sorts s'y ajoutent à chaque niveau de Magicien suivant. Les nombres exacts figurent dans la simulation et doivent être respectés. `spells: "none"` (défaut) ne sélectionne aucun sort.

La sélection se fait **classe par classe**, avec provenance `sourceClass`, vérification des sorts importés et prise en charge de leur restauration dans `snapshots`. Les listes de sorts 2024 doivent être présentes dans Foundry. La magie des sous-classes de tiers-lanceurs non prise en charge est refusée ; cela ne certifie pas toutes les règles de remplacement de sorts ni toutes les particularités du grimoire. La rétrogradation et la certification complète des règles restent hors périmètre.

### Auditer une fiche D&D 2024 sans la modifier

Appeler `validate_actor({ "actor": "ID_ACTEUR" })` pour obtenir un rapport : classes, somme des niveaux, sources de classe 2024 vérifiables, emplacements multiclasses prévus, niveaux de sorts accessibles **dans chaque classe**, listes officielles de sorts installées, nombre de sorts préparés / mineurs et conflits d'équipement visibles.

Les diagnostics distinguent `error` (contradiction vérifiable), `warning` (situation à examiner) et `unverified` (données insuffisantes). Le résultat `status` vaut `issues`, `review`, `incomplete` ou `passed_scoped_checks`. **Même le dernier ne constitue pas une certification exhaustive D&D 2024.** Les références de compendiums sont fournies lorsqu'elles ont été réellement contrôlées, sans citation de page PDF inventée. Une caractéristique aujourd'hui inférieure au seuil de multiclassage produit un avertissement : la valeur lors du choix initial peut avoir été différente.

Un grimoire de Magicien peut contenir des sorts supplémentaires copiés : il n'existe **pas de plafond absolu de six sorts + deux par niveau**. Les sorts accordés en permanence et les particularités de sous-classes ne sont pas assimilés aux préparations ordinaires. Les choix historiques de dons, aptitudes, PV et effets d'objets magiques nécessitent encore des vérifications complémentaires.

### Modifier l'équipement et les sorts préparés

`edit_actor` agit sur les **objets déjà possédés** par un personnage à classe unique D&D 2024. La simulation est la valeur par défaut ; seule l'option `apply: true` écrit dans Foundry. Récupérer les identifiants des objets embarqués avec `list_documents` et le parent `Actor.ID_ACTEUR`.

```json
{
  "actor": "ID_ACTEUR",
  "equipment": { "ID_ANCIENNE_ARME": false, "ID_NOUVELLE_ARME": true },
  "prepared_spells": { "ID_SORT_A_RETIRER": false, "ID_SORT_A_PREPARER": true }
}
```

- Pour l'équipement : une seule armure et un seul bouclier ; pas d'arme à deux mains utilisée avec un bouclier. L'absence de formation **n'interdit pas** l'usage selon les règles 2024 : une armure sans formation impose le désavantage aux tests de d20 fondés sur FOR/DEX et empêche de lancer des sorts ; un bouclier sans formation n'accorde pas son bonus de CA. Une arme sans maîtrise ne bénéficie pas du bonus de maîtrise à l'attaque. Ces cas déclenchent des avertissements. Plusieurs armes à une main peuvent être marquées portées ; les mains utilisées sont à contrôler pendant l'action.
- Pour les sorts : seuls les sorts de classe 2024 **déjà présents sur la fiche** peuvent être préparés ou retirés ; les sorts accordés en permanence ne sont pas modifiables. Le maximum de préparation provenant de la classe et le niveau des emplacements disponibles sont vérifiés. Pour remplacer un sort lorsque le maximum est atteint, retirer et préparer dans **le même appel**.
- La réponse affiche les états avant/après ; `apply: true` sauvegarde l'état initial et renvoie `instantane`, restaurable avec l'outil `snapshots` après un aperçu `dry_run`.

Ce changement d'état ne crée aucun sort, ne juge pas si le repos nécessaire pour modifier la préparation a été effectué et ne certifie pas toute la légalité D&D 2024.

### Reconstruire un personnage pour tester le MCP

**Workflow intégral :**

1. `rebuild_actor({ "source": "ID_SOURCE", "name": "Personnage reconstruit" })` vérifie les compendiums et tous les choix enregistrés (classe, espèce, historique, dons imbriqués). La simulation **n'écrit rien**.
2. Si `choix_requis` est non vide, seuls ces choix doivent être fournis dans `choices`. Un don dont la valeur d'avancement est absente peut être récupéré depuis son origine d'avancement. Même lorsqu'un ancien identifiant a été remplacé, la récupération exige un UUID de compendium et une filiation d'avancement exacts et uniques. Si cet identifiant a été **réutilisé par un autre objet** (cas réel de « Polyvalent » / « Ingénieux » / « Vigilant » d'Aurel), il faut en plus retrouver sur cet autre objet la valeur orpheline qui désigne le don choisi et sa provenance. Sinon le choix reste bloquant : aucune déduction par le nom. `choix_recuperes_via_provenance` signale les choix reconstitués et `identifiant_historique: true` indique une correspondance avec un ancien identifiant.
3. Avec `apply: true`, l'outil crée une **nouvelle fiche**, applique les avancements de la classe, de l'espèce et de l'historique depuis les sources enregistrées, puis restaure les sorts, l'équipement, les récompenses et les effets actifs de l'acteur. Les états des objets (préparation, utilisation, équipement) sont repris. Les équipements de départ ne sont pas attribués deux fois : c'est l'inventaire réel qui fait foi.
4. Le résultat contient `rapport` (différences de caractéristiques, PV, aptitudes, inventaire, sorts et `integrite_objets` pour leurs états). Une erreur d'écriture laisse éventuellement un acteur partiel **identifié** plutôt que de supprimer une fiche sans contrôle ; l'original n'est jamais modifié.

Limites : une seule classe et des UUID de compendiums vérifiables ; le contrôle est structurel, pas une preuve de légalité de chaque règle ni de tous les effets actifs.

**Workflow ciblé sur la classe uniquement :**

1. `advancement_blueprint({ "actor": "ID_SOURCE" })` renvoie les choix effectivement sauvegardés (sous-classe, dons, augmentations de caractéristique, maîtrises et choix imbriqués) ainsi que la provenance du compendium de classe. Privilégier les **identifiants** d'acteurs aux noms partiels.
2. Créer un acteur **vierge** avec `create_documents`. Ne pas y copier directement les caractéristiques finales du personnage niveau 12.
3. `advance({ "actor": "ID_CIBLE", "replay_from": "ID_SOURCE" })` choisit automatiquement le même compendium de classe, le même niveau et les choix sauvegardés. S'il manque des décisions (par exemple l'équipement de départ), `choix_requis` les liste : **aucune modification n'est appliquée** à cette étape. Refaire l'appel avec `choices` pour les seuls choix restants. Sur une fiche sans objet, les caractéristiques avant avancement de classe sont restaurées juste avant l'application.
4. `compare_actors({ "source": "ID_SOURCE", "target": "ID_CIBLE" })` montre ce qui diffère encore. Le rejeu de classe utilise `base_abilities` (bonus d'espèce/historique déjà intégrés). Pour reconstruire *également* les origines avec leur avancement, il faut repartir de `pre_origin_abilities` et ne pas appliquer deux fois ces bonus. Les sorts préparés, équipements et récompenses de campagne se traitent séparément.

Le rejeu concerne pour l'instant **une seule classe**, avec provenance de compendium vérifiable. Il ne devine ni les choix non enregistrés, ni les règles propres à une campagne. La comparaison est structurelle, elle ne garantit pas à elle seule la conformité aux règles.

## Limites

- L'assistant **graphique** de dnd5e tourne dans le navigateur et n'est pas lancé tel quel par le serveur. L'outil `advance` rejoue néanmoins côté serveur les avancements connus ; les choix non sauvegardés doivent toujours être fournis. `add_from_compendium` n'est pas équivalent à une montée de niveau complète.
- Contenus **Plutonium** des compendiums du monde (classes, sous-classes, historiques, dons) : Plutonium ne leur donne pas d'avancements dnd5e. `advance` les reconstruit à la volée (rien n'est écrit dans les compendiums, identifiants déterministes) : pour une classe, aptitudes par niveau (compendiums du monde, drapeaux `flags.plutonium` page `classFeature` et hash `<aptitude>_<classe>_<source>_<niveau>_<source>`, aptitudes de sous-classe exclues), amélioration de caractéristique / don aux sections « Level N: Ability Score Improvement » ou « … or another feat of your choice » du texte 5etools, sous-classe au niveau de la section « <Classe> Subclass », don au choix (« gain a X feat of your choice ») si cette catégorie existe dans dnd5e ; maîtrises d'armures/armes/outils et équipement de départ repris de la classe officielle de même `system.identifier` et même version de règles. **Repli** : si aucune aptitude n'est reconstructible, `advance` utilise la classe officielle de même identifiant (ex. `fighter` → `dnd5e.classes24`) et l'indique dans `avertissements`. Une classe Plutonium déjà sur une fiche est complétée au `advance` suivant. Limites : les aptitudes répétées (ex. Indomptable aux niveaux 9, 13, 17) ne sont accordées qu'une fois, comme dans le compendium ; les choix propres à une aptitude (manifestations, maîtrise des armes…) ne sont pas reconstruits.
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
| `RULES_INDEX_PATH` | `.rules/rules-index.json` | Chemin de l'index **déjà généré** par foundry-ai-agent, accompagné de `search-v1.json` dans le même dossier |
| `RULES_ACCESS_FILE` | `rules-private/access.json` | Politique facultative des livres accessibles à tous ; les autres PDF restent réservés aux MJ |
| `RULES_SEARCH_METRICS` | désactivé | `1` pour journaliser le temps de recherche sans les extraits |

### Recherche dans les livres indexés

Trois outils MCP unifient la recherche documentaire : `rules_list_sources` (sources autorisées), `rules_search` (passages BM25 courts, au maximum 8) et `rules_read_page` (page exacte par fenêtres de 6 000 caractères). Aucun chargement massif des 7 446 pages dans le contexte et aucune ré-extraction des PDF : le MCP lit l'index existant et son index de recherche optimisé.

Sur un hôte commun, renseigner le chemin de l'index et de la politique depuis le service MCP, par exemple :

```ini
RULES_INDEX_PATH=/opt/foundry-ai-agent/.rules/rules-index.json
RULES_ACCESS_FILE=/opt/foundry-ai-agent/rules-private/access.json
```

Le compte système du serveur MCP doit avoir des droits de **lecture** sur les deux fichiers, ainsi que sur `.rules/search-v1.json`, sans exposition publique des livres ni de l'index. Le fichier de politique peut contenir `{"version":1,"rules_for_all":["Player Handbook 2024.pdf"]}` (le nom doit correspondre exactement au PDF indexé). Sans déclaration, **tous les PDF privés, campagnes incluses, sont réservés au MJ** ; le SRD officiel reste accessible aux joueurs. Les PDF privés ne reçoivent aucune fausse URL publique dans les citations.

La visibilité dépend du rôle Foundry authentifié. Pour le pont IA qui se connecte en Assistant MJ au nom de joueurs, l'en-tête HTTP `X-Rules-Audience: player` restreint les outils documentaires aux sources joueurs. Cet en-tête doit être dérivé côté serveur du rôle réel du message, jamais du texte fourni à l'IA ; il ne peut pas accorder de droits MJ à un compte joueur.

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
- Droits de lecture appliqués par le MCP pour les comptes non MJ (Foundry envoie tout le monde à chaque client et laisse le navigateur masquer) : sans droit, document absent des listes et refusé en lecture ; droit limité = titre seul ; observateur ou plus = contenu. Pages de journal à droit propre, compendiums selon le rôle, jetons et combattants cachés, messages chuchotés et dossiers sans contenu visible suivent les mêmes règles (`src/access.mjs`).
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

### Data-integrity safeguards (phase 2)

- `update_documents`, `delete_documents`, `gm_sync_items` and `gm_patch_items` now require a successful recovery snapshot **before** writing to Foundry. If the original documents cannot be retrieved or `SNAPSHOT_DIR` is unavailable, the operation returns an error without starting the requested mutation. Keep this directory writable and back it up independently.
- `gm_sync_items` and `gm_patch_items` remain dry-run by default. Review the proposed changes before passing `apply: true`, especially for operations that affect multiple characters or compendiums.
- `gm_check_ids` also prepares a single recovery snapshot covering the full ID repair plan (including advancement references) before the first write.
- Snapshots are per operation, not database transactions. A Foundry error midway through a multi-document update can still leave a partial application; use `snapshots` to inspect the original values and restore affected documents. Test migrations on a disposable world before applying them to your campaign.
- Run `npm run check` for the security, OAuth, item-synchronization, combat, and snapshot-order regression tests. These unit tests use mock Foundry sessions and do not replace an integration test with a real Foundry server.

### Rules editions and dice formulas (phase 3)

- `add_from_compendium` uses the `rules` field (`"2014"` or `"2024"`) separately from `item_type` (`"spell"`, `"feat"`, etc.). When switching between installed editions it resolves the corresponding item by **name**, not by assuming the same `_id` exists in both compendiums. If the requested edition is unavailable or contradicts source metadata, the import fails rather than silently using a different ruleset. Custom packs with explicitly labelled source rules are supported without a separate `*24` pack.
- Dice formulas now respect multiplication/division precedence. Division is rounded down for D&D integer results and applied to the **rolled total**, not by silently reducing the number of dice. Variable resolution distinguishes spell slot level from spell save DC.
- `gm_sync_items` checks an item's identity when its recorded source compendium is absent, and refuses ambiguous fallback candidates; matching `_id` values alone are not considered sufficient evidence.

## Licence

MIT — not affiliated with Foundry Gaming LLC or Anthropic.
