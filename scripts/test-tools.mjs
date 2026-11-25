process.env.NO_LISTEN = "1";
// Usage : ADMIN_PASSWORD=... node scripts/test-tools.mjs <Utilisateur> '[["world_info",{}]]'
// Se connecte via le mot de passe administrateur Foundry (loginAs) pour tester les outils sans le mot de passe du joueur.
// Variante : FOUNDRY_AUTH=<base64 utilisateur:mot de passe> (même valeur que l'en-tête Basic du client MCP) ;
// l'utilisateur est alors pris dans FOUNDRY_AUTH et le premier argument est ignoré (mettre « - »).
// Les appels peuvent aussi être lus dans un fichier : node scripts/test-tools.mjs - @appels.json
// Enchaînement : « @last.chemin » reprend une valeur de la réponse précédente.
// MAXC=<n> limite l'affichage de chaque réponse (défaut 1500 caractères).
import { readFileSync } from "node:fs";
const { handleTool } = await import("../src/server.mjs");
const { FoundrySession } = await import("../src/foundry.mjs");
let s;
if (process.env.FOUNDRY_AUTH) {
  const dec = Buffer.from(process.env.FOUNDRY_AUTH.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
  const i = dec.indexOf(":");
  s = await FoundrySession.login(dec.slice(0, i), dec.slice(i + 1));
} else s = await FoundrySession.login(process.argv[2], null, { adminPassword: process.env.ADMIN_PASSWORD });
if (!s) { console.error("Connexion Foundry refusée"); process.exit(1); }
const arg = process.argv[3];
const calls = JSON.parse(arg.startsWith("@") ? readFileSync(arg.slice(1), "utf8") : arg);
// « @last.chemin » dans un argument = valeur de ce chemin dans la réponse JSON précédente (ex. "@last.proposition")
let last = null;
const subst = v => typeof v === "string" && v.startsWith("@last.") ? v.slice(6).split(".").reduce((o, k) => o?.[k], last)
  : Array.isArray(v) ? v.map(subst) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x)])) : v;
for (const [name, rawArgs] of calls) {
  const args = subst(rawArgs);
  const r = await handleTool(s, { name, arguments: args });
  try { last = JSON.parse(r.content[0].text); } catch { last = null; }
  console.log(`\n### ${name} ${JSON.stringify(args)}${r.isError ? " [ERREUR]" : ""}\n` + r.content[0].text.slice(0, Number(process.env.MAXC || 1500)));
}
s.close(); process.exit(0);
