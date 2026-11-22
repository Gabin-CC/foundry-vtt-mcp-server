// Vérifie que la liste des outils MCP est bien formée (pas de trou, noms et schémas valides).
process.env.NO_LISTEN = "1";
const { TOOLS } = await import("../src/server.mjs");
let bad = 0;
TOOLS.forEach((t, i) => {
  if (!t) { console.error(`Outil #${i} vide (virgule en trop ?)`); bad++; return; }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) { console.error(`Nom invalide : ${t.name}`); bad++; }
  if (t.inputSchema?.type !== "object") { console.error(`Schéma invalide : ${t.name}`); bad++; }
});
if (bad) process.exit(1);
console.log(`${TOOLS.length} outils OK`);
