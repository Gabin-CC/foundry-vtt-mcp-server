/**
 * Outils de MJ (comptes MJ et assistant MJ uniquement) : scènes, musique, images, journaux, jetons, combat, pause.
 * Tout passe par les documents Foundry (modifyDocument) ou par les événements socket que le serveur Foundry relaie
 * aux joueurs connectés (shareImage, showEntry, pullToScene, pause) — les mêmes que ceux du client Foundry.
 */
export const GM_ROLE = 3;   // 3 = assistant MJ, 4 = MJ

const sceneProp = { type: "string", description: "Scène (nom ou _id). Défaut : la scène active." };
export const GM_TOOLS = [
  { name: "gm_scene", gm: true, description: "MJ : scènes. list (scènes + active), activate (scène active pour tous), pull (amène les joueurs connectés sur la scène sans l'activer), darkness (obscurité 0–1).",
    inputSchema: { type: "object", required: ["action"], properties: {
      action: { type: "string", enum: ["list", "activate", "pull", "darkness"] }, scene: sceneProp,
      darkness: { type: "number", description: "Obscurité de 0 (jour) à 1 (nuit noire), pour action=darkness" } } } },
  { name: "gm_music", gm: true, description: "MJ : musique et ambiances (playlists Foundry). list, play (playlist entière ou un morceau), stop (playlist ou morceau), stop_all, volume (0–1).",
    inputSchema: { type: "object", required: ["action"], properties: {
      action: { type: "string", enum: ["list", "play", "stop", "stop_all", "volume"] },
      playlist: { type: "string", description: "Playlist (nom ou _id)" }, sound: { type: "string", description: "Morceau de la playlist (nom ou _id), optionnel" },
      volume: { type: "number", description: "0 à 1, pour action=volume" } } } },
  { name: "gm_show", gm: true, description: "MJ : montrer aux joueurs une image (fenêtre plein écran chez eux) ou un journal / une page de journal. Pour une image locale, l'envoyer d'abord avec upload_file.",
    inputSchema: { type: "object", properties: {
      image: { type: "string", description: "Chemin ou URL de l'image (ex. images/pnj/x.webp)" }, title: { type: "string" },
      journal: { type: "string", description: "Journal (nom ou _id), ou UUID d'une page (JournalEntry.x.JournalEntryPage.y)" },
      force: { type: "boolean", description: "Montrer le journal à tous, même sans droit de lecture", default: true } } } },
  { name: "gm_tile", gm: true, description: "MJ : poser une image sur le plateau (tuile) de la scène, en cases depuis le coin haut-gauche. Sans position : centrée.",
    inputSchema: { type: "object", required: ["image"], properties: {
      image: { type: "string" }, scene: sceneProp, x: { type: "number", description: "Colonne (cases)" }, y: { type: "number", description: "Ligne (cases)" },
      width: { type: "number", description: "Largeur en cases (défaut 4)" }, height: { type: "number", description: "Hauteur en cases (défaut = largeur)" },
      hidden: { type: "boolean", description: "Visible du MJ seulement" } } } },
  { name: "gm_token", gm: true, description: "MJ : jetons. place (pose le jeton d'un acteur), move, remove, hide, show. Positions en cases depuis le coin haut-gauche.",
    inputSchema: { type: "object", required: ["action"], properties: {
      action: { type: "string", enum: ["list", "place", "move", "remove", "hide", "show"] }, scene: sceneProp,
      actor: { type: "string", description: "Acteur (nom ou _id), pour place" }, token: { type: "string", description: "Jeton (nom ou _id), pour move/remove/hide/show" },
      x: { type: "number" }, y: { type: "number" }, hidden: { type: "boolean", description: "Pour place : jeton caché" } } } },
  { name: "gm_combat", gm: true, description: "MJ : combat sur une scène. start (crée le combat avec les jetons de la scène, ou ceux listés), next (tour suivant), previous, end. L'initiative se lance avec check kind=initiative.",
    inputSchema: { type: "object", required: ["action"], properties: {
      action: { type: "string", enum: ["start", "next", "previous", "end", "status"] }, scene: sceneProp,
      tokens: { type: "array", items: { type: "string" }, description: "Jetons à inclure (noms ou _id) ; défaut : tous les jetons de la scène" } } } },
  { name: "gm_pause", gm: true, description: "MJ : met la partie en pause ou la reprend pour tous les joueurs.",
    inputSchema: { type: "object", required: ["paused"], properties: { paused: { type: "boolean" } } } },
];

const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
function byRef(list, ref, what) {
  if (!ref) return null;
  const d = list.find(x => x._id === ref) || list.find(x => norm(x.name) === norm(ref)) || list.find(x => norm(x.name).includes(norm(ref)));
  if (!d) throw new Error(`${what} introuvable : ${ref}`);
  return d;
}
async function sceneOf(fs, ref) {
  const scenes = await fs.doc("get", "Scene", { query: {} });
  const s = ref ? byRef(scenes, ref, "Scène") : scenes.find(x => x.active);
  if (!s) throw new Error("Aucune scène active : préciser 'scene'");
  return s;
}
const grid = s => Number(s.grid?.size) || 100;
const now = () => Date.now();

export async function handleGm(fs, name, a) {
  switch (name) {
    case "gm_scene": {
      const scenes = await fs.doc("get", "Scene", { query: {} });
      if (a.action === "list") return { active: scenes.find(s => s.active)?.name || null, scenes: scenes.map(s => ({ _id: s._id, nom: s.name, active: !!s.active, navigation: !!s.navigation })) };
      const s = a.scene ? byRef(scenes, a.scene, "Scène") : scenes.find(x => x.active);
      if (!s) throw new Error("Préciser 'scene'");
      if (a.action === "activate") { await fs.doc("update", "Scene", { updates: [{ _id: s._id, active: true }], modifiedTime: now() }); return `Scène active : ${s.name}`; }
      if (a.action === "pull") {
        const users = await fs.doc("get", "User", { query: {} });
        for (const u of users) if (u._id !== fs.userId) await fs.broadcast("pullToScene", s._id, u._id, {});
        return `Joueurs connectés amenés sur : ${s.name}`;
      }
      if (a.action === "darkness") {
        const v = Math.max(0, Math.min(1, Number(a.darkness)));
        await fs.doc("update", "Scene", { updates: [{ _id: s._id, "environment.darknessLevel": v }], modifiedTime: now() });
        return `Obscurité de ${s.name} : ${v}`;
      }
      break;
    }
    case "gm_music": {
      const pls = await fs.doc("get", "Playlist", { query: {} });
      if (a.action === "list") return pls.map(p => ({ _id: p._id, nom: p.name, en_cours: !!p.playing, morceaux: (p.sounds || []).map(s => `${s.name}${s.playing ? " ▶" : ""}`) }));
      if (a.action === "stop_all") {
        for (const p of pls.filter(p => p.playing || (p.sounds || []).some(s => s.playing))) {
          await fs.doc("update", "Playlist", { updates: [{ _id: p._id, playing: false }], modifiedTime: now() });
          const on = (p.sounds || []).filter(s => s.playing).map(s => ({ _id: s._id, playing: false }));
          if (on.length) await fs.doc("update", "PlaylistSound", { parentUuid: `Playlist.${p._id}`, updates: on, modifiedTime: now() });
        }
        return "Musique arrêtée";
      }
      const p = byRef(pls, a.playlist, "Playlist");
      if (!p) throw new Error("Préciser 'playlist'");
      const snd = a.sound ? byRef(p.sounds || [], a.sound, "Morceau") : null;
      if (a.action === "play") {
        if (snd) await fs.doc("update", "PlaylistSound", { parentUuid: `Playlist.${p._id}`, updates: [{ _id: snd._id, playing: true }], modifiedTime: now() });
        else {
          // lecture de la playlist : premier morceau (ou tous en mode simultané), comme Playlist#playAll
          await fs.doc("update", "Playlist", { updates: [{ _id: p._id, playing: true }], modifiedTime: now() });
          const first = (p.sounds || []).slice().sort((x, y) => (x.sort || 0) - (y.sort || 0));
          const targets = p.mode === 2 ? first : first.slice(0, 1);   // 2 = simultané
          if (targets.length) await fs.doc("update", "PlaylistSound", { parentUuid: `Playlist.${p._id}`, updates: targets.map(s => ({ _id: s._id, playing: true })), modifiedTime: now() });
        }
        return `Lecture : ${snd ? snd.name + " (" + p.name + ")" : p.name}`;
      }
      if (a.action === "stop") {
        const on = (snd ? [snd] : (p.sounds || []).filter(s => s.playing)).map(s => ({ _id: s._id, playing: false }));
        if (on.length) await fs.doc("update", "PlaylistSound", { parentUuid: `Playlist.${p._id}`, updates: on, modifiedTime: now() });
        if (!snd) await fs.doc("update", "Playlist", { updates: [{ _id: p._id, playing: false }], modifiedTime: now() });
        return `Arrêt : ${snd ? snd.name : p.name}`;
      }
      if (a.action === "volume") {
        const v = Math.max(0, Math.min(1, Number(a.volume)));
        const list = (snd ? [snd] : p.sounds || []).map(s => ({ _id: s._id, volume: v }));
        await fs.doc("update", "PlaylistSound", { parentUuid: `Playlist.${p._id}`, updates: list, modifiedTime: now() });
        return `Volume ${v} : ${snd ? snd.name : p.name}`;
      }
      break;
    }
    case "gm_show": {
      const done = [];
      if (a.image) { await fs.broadcast("shareImage", { image: a.image, title: a.title || "", users: [], showTitle: !!a.title }); done.push(`image ${a.image}`); }
      if (a.journal) {
        let uuid = a.journal;
        if (!uuid.includes(".")) { const j = byRef(await fs.doc("get", "JournalEntry", { query: {} }), a.journal, "Journal"); uuid = `JournalEntry.${j._id}`; }
        await fs.broadcast("showEntry", uuid, { force: a.force !== false, users: [] });
        done.push(`journal ${uuid}`);
      }
      if (!done.length) throw new Error("Préciser 'image' ou 'journal'");
      return `Montré aux joueurs : ${done.join(", ")}`;
    }
    case "gm_tile": {
      const s = await sceneOf(fs, a.scene); const g = grid(s);
      const w = (Number(a.width) || 4) * g, h = (Number(a.height) || Number(a.width) || 4) * g;
      const x = a.x != null ? Number(a.x) * g : Math.round((Number(s.width) || 4000) / 2 - w / 2);
      const y = a.y != null ? Number(a.y) * g : Math.round((Number(s.height) || 3000) / 2 - h / 2);
      const [t] = await fs.doc("create", "Tile", { parentUuid: `Scene.${s._id}`, data: [{ texture: { src: a.image }, x, y, width: w, height: h, hidden: !!a.hidden }], modifiedTime: now() });
      return `Tuile posée sur ${s.name} (${t?._id})`;
    }
    case "gm_token": {
      const s = await sceneOf(fs, a.scene); const g = grid(s);
      const tokens = await fs.doc("get", "Token", { parentUuid: `Scene.${s._id}`, query: {} });
      if (a.action === "list") return tokens.map(t => ({ _id: t._id, nom: t.name, x: Math.round(t.x / g), y: Math.round(t.y / g), cache: !!t.hidden, actor: t.actorId }));
      if (a.action === "place") {
        const actors = await fs.doc("get", "Actor", { query: {} });
        const act = byRef(actors, a.actor, "Acteur");
        const pt = structuredClone(act.prototypeToken || {});
        const data = { ...pt, actorId: act._id, name: pt.name || act.name, x: (Number(a.x) || 0) * g, y: (Number(a.y) || 0) * g, hidden: !!a.hidden };
        const [t] = await fs.doc("create", "Token", { parentUuid: `Scene.${s._id}`, data: [data], modifiedTime: now() });
        return `Jeton de ${act.name} posé sur ${s.name} (${t?._id})`;
      }
      const t = byRef(tokens, a.token, "Jeton");
      if (a.action === "remove") { await fs.doc("delete", "Token", { parentUuid: `Scene.${s._id}`, ids: [t._id], modifiedTime: now() }); return `Jeton retiré : ${t.name}`; }
      const upd = { _id: t._id };
      if (a.action === "move") { if (a.x != null) upd.x = Number(a.x) * g; if (a.y != null) upd.y = Number(a.y) * g; }
      if (a.action === "hide") upd.hidden = true;
      if (a.action === "show") upd.hidden = false;
      await fs.doc("update", "Token", { parentUuid: `Scene.${s._id}`, updates: [upd], modifiedTime: now() });
      return `Jeton ${t.name} : ${a.action}`;
    }
    case "gm_combat": {
      const combats = await fs.doc("get", "Combat", { query: {} });
      if (a.action === "start") {
        const s = await sceneOf(fs, a.scene);
        const tokens = await fs.doc("get", "Token", { parentUuid: `Scene.${s._id}`, query: {} });
        const chosen = a.tokens?.length ? a.tokens.map(r => byRef(tokens, r, "Jeton")) : tokens;
        const [c] = await fs.doc("create", "Combat", { data: [{ scene: s._id, active: true, round: 0, turn: null }], modifiedTime: now() });
        if (chosen.length) await fs.doc("create", "Combatant", { parentUuid: `Combat.${c._id}`, data: chosen.map(t => ({ tokenId: t._id, sceneId: s._id, actorId: t.actorId, hidden: !!t.hidden })), modifiedTime: now() });
        return `Combat créé sur ${s.name} avec ${chosen.length} combattant(s). Lancer l'initiative : check kind=initiative ; puis gm_combat next pour commencer.`;
      }
      const c = combats.find(x => x.active) || combats[0];
      if (!c) throw new Error("Aucun combat en cours");
      const cbs = (await fs.doc("get", "Combatant", { parentUuid: `Combat.${c._id}`, query: {} }))
        .sort((x, y) => (Number(y.initiative) || -99) - (Number(x.initiative) || -99));
      if (a.action === "status") return { round: c.round, tour: c.turn, ordre: cbs.map(x => `${x.name || x.actorId} (${x.initiative ?? "—"})`) };
      if (a.action === "end") { await fs.doc("delete", "Combat", { ids: [c._id], modifiedTime: now() }); return "Combat terminé"; }
      let round = Number(c.round) || 0, turn = c.turn == null ? -1 : Number(c.turn);
      if (a.action === "next") { turn++; if (round === 0 || turn >= cbs.length) { round++; turn = 0; } }
      if (a.action === "previous") { turn--; if (turn < 0) { round = Math.max(1, round - 1); turn = cbs.length - 1; } }
      await fs.doc("update", "Combat", { updates: [{ _id: c._id, round, turn }], modifiedTime: now() });
      return `Round ${round}, au tour de : ${cbs[turn]?.name || cbs[turn]?.actorId || "?"}`;
    }
    case "gm_pause": {
      await fs.broadcast("pause", !!a.paused, { broadcast: true, userId: fs.userId });
      return a.paused ? "Partie en pause" : "Partie reprise";
    }
  }
  throw new Error(`Action non prise en charge : ${a.action}`);
}
