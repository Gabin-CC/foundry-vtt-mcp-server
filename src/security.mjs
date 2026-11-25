/** Utilities for writing user-controlled paths without traversing object prototypes. */
import { message } from "./i18n.mjs";
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function setSafePath(target, path, value) {
  if (typeof path !== "string" || !path) throw new Error(message("Document path must be a non-empty string", "Le chemin du document doit être une chaîne non vide"));
  const segments = path.split(".");
  if (segments.some(segment => !segment || FORBIDDEN_SEGMENTS.has(segment))) {
    throw new Error(message(`Unsafe document path: ${path}`, `Chemin de document dangereux : ${path}`));
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== "object") throw new Error(message(`Invalid document path: ${path}`, `Chemin de document invalide : ${path}`));
    if (!Object.hasOwn(current, segment) || current[segment] == null) current[segment] = {};
    if (!current[segment] || typeof current[segment] !== "object") {
      throw new Error(message(`Invalid document path: ${path}`, `Chemin de document invalide : ${path}`));
    }
    current = current[segment];
  }
  if (!current || typeof current !== "object") throw new Error(message(`Invalid document path: ${path}`, `Chemin de document invalide : ${path}`));
  current[segments.at(-1)] = value;
  return target;
}
