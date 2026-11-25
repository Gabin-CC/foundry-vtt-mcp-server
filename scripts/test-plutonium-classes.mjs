// Classes importées par Plutonium dans un compendium du monde : reconstruction des avancements (aptitudes par
// niveau, amélioration de caractéristique / don, sous-classe, don au choix, maîtrises et équipement repris de la
// classe officielle équivalente) et repli sur la classe officielle quand rien n'est reconstructible.
// Données FICTIVES uniquement (classe « Warden », source « TST ») qui imitent la structure Plutonium observée.
import assert from "node:assert/strict";
import fsys from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const temporary = fsys.mkdtempSync(path.join(os.tmpdir(), "foundry-plutonium-classes-"));
process.env.SNAPSHOT_DIR = path.join(temporary, "snapshots");
process.env.NO_LISTEN = "1";
after(() => fsys.rmSync(temporary, { recursive: true, force: true }));
// pas de fichiers de traduction Babele
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const [{ synthesize, classSections, officialEquivalent }, { plan, preferOfficialClass, retrofitClass }, { fixId }, { handleTool }, { message }] =
  await Promise.all([import("../src/synth.mjs"), import("../src/advancement.mjs"), import("../src/repair.mjs"),
    import("../src/server.mjs"), import("../src/i18n.mjs")]);

const id = p => (p + "0000000000000000").slice(0, 16);
const VALID = /^[A-Za-z0-9]{16}$/;
const advOf = d => Array.isArray(d.system.advancement) ? d.system.advancement : Object.values(d.system.advancement || {});

// ---- fixtures ----
const section = (level, name, body) =>
  `<div data-roll-name-ancestor="Level ${level}: ${name}" data-source="TST" class="ve-rd__b"><h2><span>Level ${level}: ${name}</span></h2><p>${body}</p></div>`;
const DESCRIPTION = `<table><tr><td>1st</td><td>+2</td><td>Iron Resolve</td></tr></table>`
  + section(1, "Combat Stance", `You gain a <a href="https://example.invalid">Combat Stance feat</a> of your choice.`)
  + section(1, "Iron Resolve", "You can steady yourself.")
  + section(2, "Rallying Call", "You shout.")
  + section(3, "Warden Subclass", "You gain a Warden subclass of your choice.")
  + section(4, "Ability Score Improvement", `You gain the @feat[Ability Score Improvement|TST] feat or another <a href="x">feat</a> of your choice for which you qualify.`)
  + section(5, "Subclass Feature", "You gain a feature from your Warden Subclass.")
  + section(19, "Grand Boon", `You gain a <a href="x">Grand Boon feat</a> or another <a href="x">feat</a> of your choice for which you qualify.`);

const CLASS_ID = id("plutowarden"), BARE_ID = id("plutoseeker"), SUB_ID = id("plutobulwark");
const pluClass = (over = {}) => ({
  _id: CLASS_ID, name: "Warden", type: "class",
  flags: { plutonium: { page: "classes.html", source: "TST", hash: "warden_tst", propDroppable: "class" } },
  system: {
    identifier: "warden", source: { book: "Test Book", rules: "2024" }, levels: 1, hd: { denomination: "d10" },
    description: { value: DESCRIPTION }, startingEquipment: [],
    advancement: [
      { _id: id("hpadv"), type: "HitPoints", configuration: {}, value: {} },
      { _id: id("saveadv"), type: "Trait", level: 1, title: "Saving Throws", classRestriction: "primary",
        configuration: { mode: "default", allowReplacements: false, grants: ["saves:str", "saves:con"], choices: [] }, value: {} },
      { _id: id("skilladv"), type: "Trait", level: 1, title: "Skills", classRestriction: "primary",
        configuration: { mode: "default", allowReplacements: false, grants: [], choices: [{ count: 2, pool: ["skills:ath", "skills:prc", "skills:sur"] }] }, value: {} },
      { _id: id("scaleadv"), type: "ScaleValue", title: "Iron Resolve", configuration: { type: "number", scale: { 1: { value: 2 } } }, value: {} }
    ]
  },
  ...over
});
const feature = (key, name, hash, page = "classFeature") => ({
  _id: id(key), name, type: "feat", flags: { plutonium: { page, source: "TST", hash: encodeURIComponent(hash), propDroppable: page } },
  system: { type: { value: "class", subtype: "" }, description: { value: `<p>${name}.</p>` }, advancement: [] }
});
const FEATURES = [
  feature("fstance", "Combat Stance", "combat stance_warden_tst_1_tst"),
  feature("firon", "Iron Resolve", "iron resolve_warden_tst_1_tst"),
  feature("frally", "Rallying Call", "rallying call_warden_tst_2_tst"),
  feature("fboon", "Grand Boon", "grand boon_warden_tst_19_tst"),
  feature("fwall", "Shield Wall", "shield wall_warden_tst_bulwark_tst_3_tst", "subclassFeature"),
  feature("fother", "Other Class Thing", "other class thing_seeker_tst_1_tst")
];
const OFFICIAL_ID = id("offwarden");
const OFFICIAL = {
  _id: OFFICIAL_ID, name: "Warden", type: "class",
  system: {
    identifier: "warden", source: { book: "Test Book", rules: "2024" },
    advancement: [
      { _id: id("offhp"), type: "HitPoints", configuration: {}, value: {} },
      { _id: id("offsaves"), type: "Trait", level: 1, classRestriction: "primary", configuration: { grants: ["saves:str", "saves:con"], choices: [] }, value: {} },
      { _id: id("offarmor"), type: "Trait", level: 1, title: "Armor Training", classRestriction: "primary", configuration: { mode: "default", grants: ["armor:lgt", "armor:shl"], choices: [] }, value: { chosen: [] } },
      { _id: id("offweapon"), type: "Trait", level: 1, title: "Weapon Proficiencies", configuration: { mode: "default", grants: ["weapon:sim"], choices: [] }, value: {} },
      { _id: id("offgrant"), type: "ItemGrant", level: 1, configuration: { items: [{ uuid: `Compendium.dnd5e.classes24.Item.${id("offfeat")}` }] }, value: {} }
    ],
    startingEquipment: [
      { _id: id("eqor"), type: "OR", group: "", sort: 1 },
      { _id: id("eqand"), type: "AND", group: id("eqor"), sort: 2 },
      { _id: id("eqgear"), type: "linked", key: `Compendium.dnd5e.items.Item.${id("rope")}`, count: 1, group: id("eqand"), sort: 3 },
      { _id: id("eqgold"), type: "currency", key: "gp", count: 50, group: id("eqor"), sort: 4 }
    ]
  }
};
const STANCE_FEAT = { _id: id("stancefeat"), name: "Steady Guard", type: "feat", system: { type: { value: "feat", subtype: "combatStance" }, prerequisites: { level: null }, advancement: [] } };

function fakeWorld({ classes = [pluClass()], features = FEATURES, official = [OFFICIAL], actors = [] } = {}) {
  const packDocs = {
    "world.classes": [...classes, { _id: SUB_ID, name: "Bulwark", type: "subclass",
      flags: { plutonium: { hash: "warden_tst,state:sub_bulwark_tst=b1" } }, system: { identifier: "bulwark", classIdentifier: "warden", advancement: [] } }],
    "world.features": features,
    "world.items": [{ _id: id("worlditem"), name: "Lantern", type: "loot", system: {} }],
    "dnd5e.classes24": official,
    "dnd5e.feats24": [STANCE_FEAT]
  };
  const packs = Object.keys(packDocs).map(p => ({ id: p, type: "Item", packageName: p.split(".")[0], label: p }));
  const writes = [];
  const match = (list, q = {}) => list.filter(d => Object.entries(q).every(([k, v]) => d[k] === v));
  const session = {
    userId: id("gm"), user: { id: id("gm"), name: "GM", role: 4 }, world: { id: "test-world" },
    async worldData() { return { packs: structuredClone(packs) }; },
    async doc(action, type, op = {}) {
      if (action === "get") {
        if (type === "Setting") return [];
        if (op.pack) return structuredClone(match(packDocs[op.pack] || [], op.query));
        if (type === "Actor") return structuredClone(match(actors, op.query));
        if (op.parentUuid) return structuredClone(actors.find(a => `Actor.${a._id}` === op.parentUuid)?.items || []);
        return [];
      }
      writes.push({ action, type, op });
      if (action === "create") return op.data.map((d, i) => ({ _id: id(`new${writes.length}${i}`), ...structuredClone(d) }));
      return op.updates || [];
    }
  };
  return { session, writes };
}
const fetchRaw = async (session, uuid) => {
  const [, a, b, , i] = uuid.split(".");
  return (await session.doc("get", "Item", { pack: `${a}.${b}`, query: { _id: i } }))[0];
};
const synth = async (session, doc) => synthesize(session, structuredClone(doc), structuredClone(doc));

// ---- tests ----
test("sections 5etools « Level N: Nom » d'une classe Plutonium", () => {
  const secs = classSections(DESCRIPTION);
  assert.deepEqual(secs.map(s => [s.level, s.name]), [[1, "Combat Stance"], [1, "Iron Resolve"], [2, "Rallying Call"],
    [3, "Warden Subclass"], [4, "Ability Score Improvement"], [5, "Subclass Feature"], [19, "Grand Boon"]]);
  assert.match(secs[0].body, /gain a Combat Stance feat of your choice/);
});

test("classe Plutonium : aptitudes par niveau, ASI/don, sous-classe, don au choix, maîtrises et équipement reconstruits", async () => {
  const { session } = fakeWorld();
  const doc = await synth(session, pluClass());
  const adv = advOf(doc);
  // avancements d'origine conservés
  for (const k of ["hpadv", "saveadv", "skilladv", "scaleadv"]) assert.ok(adv.some(a => a._id === id(k)), k);
  const grants = adv.filter(a => a.type === "ItemGrant");
  const byLevel = Object.fromEntries(grants.map(g => [g.level, g.configuration.items.map(i => i.uuid.split(".").pop())]));
  assert.deepEqual(byLevel, { 1: [id("fstance"), id("firon")], 2: [id("frally")] },
    "aptitudes de la classe seulement : ni sous-classe, ni autre classe, ni « Grand Boon » (devenu un choix de don)");
  assert.ok(grants.every(g => g.configuration.items.every(i => i.uuid.startsWith("Compendium.world.features.Item."))));
  const asi = adv.filter(a => a.type === "AbilityScoreImprovement");
  assert.deepEqual(asi.map(a => [a.level, a.title]), [[4, "Ability Score Improvement"], [19, "Grand Boon"]]);
  assert.deepEqual(asi[0].configuration.locked, []);
  assert.equal(asi[0].configuration.points, 2);
  assert.deepEqual(adv.filter(a => a.type === "Subclass").map(a => a.level), [3]);
  const choice = adv.find(a => a.type === "ItemChoice");
  assert.equal(choice.level, 1);
  assert.deepEqual(choice.configuration.restriction, { type: "feat", subtype: "combatStance", list: [] });
  // maîtrises d'armures/armes de la classe officielle équivalente (pas ses sauvegardes, déjà présentes)
  const traits = adv.filter(a => a.type === "Trait").map(a => a.configuration.grants?.join(",") || a.title);
  assert.deepEqual(traits.sort(), ["Skills", "armor:lgt,armor:shl", "saves:str,saves:con", "weapon:sim"].sort());
  // équipement de départ repris, groupes cohérents après renommage des identifiants
  const se = doc.system.startingEquipment;
  assert.equal(se.length, 4);
  const ids = new Set(se.map(e => e._id));
  assert.ok(se.every(e => e.group === "" || ids.has(e.group)));
  assert.equal(doc.flags.mcp.synthesizedAdvancement, true);
  // identifiants valides (16 alphanumériques, inchangés par fixId), uniques
  const all = [...adv.map(a => a._id), ...se.map(e => e._id)];
  assert.ok(all.every(x => VALID.test(x) && fixId(x) === x), all.join(" "));
  assert.equal(new Set(all).size, all.length);
});

test("classe Plutonium : identifiants stables (même entrée -> mêmes identifiants)", async () => {
  const a = await synth(fakeWorld().session, pluClass());
  const b = await synth(fakeWorld().session, pluClass());
  assert.deepEqual(advOf(a).map(x => x._id), advOf(b).map(x => x._id));
  assert.deepEqual(a.system.startingEquipment.map(x => x._id), b.system.startingEquipment.map(x => x._id));
});

test("classe qui accorde déjà ses aptitudes, ou sans drapeaux Plutonium : inchangée", async () => {
  const { session } = fakeWorld();
  const withGrant = pluClass();
  withGrant.system.advancement.push({ _id: id("grant"), type: "ItemGrant", level: 1, configuration: { items: [] }, value: {} });
  assert.equal(advOf(await synth(session, withGrant)).length, 5);
  const plain = pluClass({ flags: {} });
  assert.equal(advOf(await synth(session, plain)).length, 4);
});

test("plan d'avancement d'une classe reconstruite : choix demandés aux bons niveaux", async () => {
  const { session } = fakeWorld();
  const doc = await synth(session, pluClass());
  const r = await plan(session, { items: [] }, doc, { fromLevel: 1, toLevel: 4, choices: {}, isFirstClass: true });
  const pending = r.pending.map(p => [p.type, p.niveau]);
  assert.deepEqual(pending.sort(), [["AbilityScoreImprovement", 4], ["ItemChoice", 1], ["StartingEquipment", 1], ["Subclass", 3], ["Trait", 1]].sort());
  assert.ok(r.pending.find(p => p.type === "ItemChoice").options.some(o => o.includes(STANCE_FEAT._id)), "dons de la catégorie proposés");
  const granted = r.steps.filter(s => s.kind === "grant").flatMap(s => s.docs.map(d => d.doc.name));
  assert.deepEqual(granted.sort(), ["Combat Stance", "Iron Resolve", "Rallying Call"]);
  assert.ok(r.steps.some(s => s.kind === "trait" && s.chosen.includes("armor:lgt")));
});

test("repli : classe sans aptitude reconstructible -> classe officielle de même identifiant, avec message", async () => {
  const bare = pluClass({ _id: BARE_ID, name: "Seeker", flags: { plutonium: { hash: "seeker_tst" } } });
  bare.system = { ...bare.system, identifier: "warden", description: { value: "<p>No sections.</p>" } };
  const { session } = fakeWorld({ classes: [bare], features: [] });
  const doc = await synth(session, bare);
  assert.ok(!advOf(doc).some(a => ["ItemGrant", "Subclass", "ItemChoice"].includes(a.type)), "rien d'inventé");
  const src = `Compendium.world.classes.Item.${BARE_ID}`;
  const r = await preferOfficialClass(session, doc, src);
  assert.equal(r.src, `Compendium.dnd5e.classes24.Item.${OFFICIAL_ID}`);
  assert.equal(r.root._id, OFFICIAL_ID);
  assert.match(r.note, /warden/);
  assert.match(r.note, new RegExp(OFFICIAL_ID));
  // sans équivalent officiel : on garde la classe et on prévient
  const none = await preferOfficialClass(fakeWorld({ classes: [bare], features: [], official: [] }).session, doc, src);
  assert.equal(none.root, doc);
  assert.match(none.note, new RegExp(message("no official class", "aucune classe officielle")));
  // classe reconstruite : pas de repli
  const ok = await synth(fakeWorld().session, pluClass());
  assert.equal((await preferOfficialClass(fakeWorld().session, ok, "x")).note, null);
});

test("équivalent officiel : même identifiant et même version de règles en priorité", async () => {
  const legacy = structuredClone(OFFICIAL);
  legacy._id = id("offlegacy"); legacy.system.source.rules = "2014";
  const { session } = fakeWorld({ official: [legacy, OFFICIAL] });
  assert.equal((await officialEquivalent(session, pluClass())).id, OFFICIAL_ID);
  assert.equal(await officialEquivalent(session, { type: "class", system: { identifier: "unknown" } }), null);
});

test("classe Plutonium déjà sur une fiche, importée sans aptitudes : avancements manquants complétés", async () => {
  const { session } = fakeWorld();
  const onSheet = { ...pluClass(), _id: id("actorclass"), _stats: { compendiumSource: `Compendium.world.classes.Item.${CLASS_ID}` } };
  const r = await retrofitClass(session, onSheet);
  assert.ok(r.added.some(a => a.type === "ItemGrant" && a.level === 1));
  assert.ok(!r.added.some(a => a._id === id("hpadv")), "les avancements présents ne sont pas réécrits");
  // mêmes identifiants qu'à l'import : une classe importée avec ses avancements reconstruits n'a rien à compléter
  const imported = await synth(session, pluClass());
  assert.deepEqual(r.added.map(a => a._id).sort(), advOf(imported).filter(a => !advOf(pluClass()).some(o => o._id === a._id)).map(a => a._id).sort());
  assert.equal(await retrofitClass(session, { ...imported, _stats: onSheet._stats }), null);
});

test("advance : import d'une classe Plutonium -> choix demandés et message de reconstruction", async () => {
  const actor = { _id: id("hero"), name: "Hero", type: "character", items: [], system: { abilities: {}, details: {}, attributes: { hp: { value: 0, max: 0 } } } };
  const { session, writes } = fakeWorld({ actors: [actor] });
  const r = await handleTool(session, { name: "advance", arguments: { actor: actor._id, source: { pack: "world.classes", id: CLASS_ID }, level: 1 } });
  const body = JSON.parse(r.content[0].text);
  assert.ok(body.choix_requis.some(c => c.type === "ItemChoice"), r.content[0].text);
  assert.ok(body.avertissements.some(w => /Plutonium/.test(w)));
  assert.equal(writes.length, 0, "rien n'est écrit tant que des choix manquent");
});

test("advance : classe Plutonium sans aptitude -> classe officielle utilisée, message explicite", async () => {
  const bare = pluClass({ _id: BARE_ID, name: "Seeker", flags: { plutonium: { hash: "seeker_tst" } } });
  bare.system = { ...bare.system, description: { value: "<p>No sections.</p>" } };
  const actor = { _id: id("hero"), name: "Hero", type: "character", items: [], system: { abilities: {}, details: {}, attributes: { hp: { value: 0, max: 0 } } } };
  const { session } = fakeWorld({ classes: [bare], features: [], actors: [actor] });
  const r = await handleTool(session, { name: "advance", arguments: { actor: actor._id, source: { pack: "world.classes", id: BARE_ID }, level: 1 } });
  const text = r.content[0].text;
  assert.match(text, new RegExp(`Compendium.dnd5e.classes24.Item.${OFFICIAL_ID}`));
  assert.match(text, /warden/);
});

test("sous-classe Plutonium : aptitudes trouvées dans n'importe quel compendium d'objets du monde", async () => {
  const { session } = fakeWorld();
  const sub = (await session.doc("get", "Item", { pack: "world.classes", query: { _id: SUB_ID } }))[0];
  const doc = await synth(session, sub);
  const grants = advOf(doc).filter(a => a.type === "ItemGrant");
  assert.deepEqual(grants.map(g => [g.level, g.configuration.items.map(i => i.uuid)]), [[3, [`Compendium.world.features.Item.${id("fwall")}`]]]);
  assert.ok(grants.every(g => VALID.test(g._id)));
});
