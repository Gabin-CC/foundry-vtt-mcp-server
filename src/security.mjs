/** Utilities for writing user-controlled paths without traversing object prototypes. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function setSafePath(target, path, value) {
  if (typeof path !== "string" || !path) throw new Error("Document path must be a non-empty string");
  const segments = path.split(".");
  if (segments.some(segment => !segment || FORBIDDEN_SEGMENTS.has(segment))) {
    throw new Error(`Unsafe document path: ${path}`);
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== "object") throw new Error(`Invalid document path: ${path}`);
    if (!Object.hasOwn(current, segment) || current[segment] == null) current[segment] = {};
    if (!current[segment] || typeof current[segment] !== "object") {
      throw new Error(`Invalid document path: ${path}`);
    }
    current = current[segment];
  }
  if (!current || typeof current !== "object") throw new Error(`Invalid document path: ${path}`);
  current[segments.at(-1)] = value;
  return target;
}
