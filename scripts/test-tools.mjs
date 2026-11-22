process.env.NO_LISTEN = "1";
// Usage : ADMIN_PASSWORD=... node scripts/test-tools.mjs <Utilisateur> '[["world_info",{}]]'
// Se connecte via le mot de passe administrateur Foundry (loginAs) pour tester les outils sans le mot de passe du joueur.
const { handleTool } = await import("../src/server.mjs");
const { FoundrySession } = await import("../src/foundry.mjs");
const s = await FoundrySession.login(process.argv[2], null, { adminPassword: process.env.ADMIN_PASSWORD });
const calls = JSON.parse(process.argv[3]);
for (const [name, args] of calls) {
  const r = await handleTool(s, { name, arguments: args });
  console.log(`\n### ${name} ${JSON.stringify(args)}${r.isError ? " [ERREUR]" : ""}\n` + r.content[0].text.slice(0, Number(process.env.MAXC || 1500)));
}
s.close(); process.exit(0);
