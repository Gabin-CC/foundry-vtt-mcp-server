/** Safe, bounded uploads for the Foundry data directory. */
import { lookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { message } from "./i18n.mjs";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;

const MIME_BY_EXTENSION = Object.freeze({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  webm: "video/webm", mp4: "video/mp4", pdf: "application/pdf"
});

const privateIPv4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
]) privateIPv4.addSubnet(address, prefix, "ipv4");

const privateIPv6 = new BlockList();
const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
]) privateIPv6.addSubnet(address, prefix, "ipv6");

/** Allow globally routable IPv4/IPv6 only; forbid local, special, and tunneled ranges. */
export function isPublicAddress(input) {
  const address = String(input).replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) return !privateIPv4.check(address, "ipv4");
  if (family === 6) {
    return globalIPv6.check(address, "ipv6") && !privateIPv6.check(address, "ipv6");
  }
  return false;
}

const safeName = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u;
const safeFolderSegment = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

export function validateUploadDestination(filename, folder = "images/uploads") {
  if (typeof filename !== "string" || filename.length > 128 || !safeName.test(filename) || filename.includes("..")) {
    throw new Error(message("Unsafe upload filename", "Nom de fichier téléversé dangereux"));
  }
  if (typeof folder !== "string" || folder.length > 256 ||
      !folder.split("/").every(segment => safeFolderSegment.test(segment) && !segment.includes(".."))) {
    throw new Error(message("Unsafe upload folder", "Dossier de téléversement dangereux"));
  }
  const extension = filename.split(".").at(-1).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) throw new Error(message(`Unsupported upload format: ${extension}`, `Format de téléversement non pris en charge : ${extension}`));
  return { filename, folder, mime };
}

/** Inspect file signatures: trusting the filename or HTTP Content-Type is not sufficient. */
export function validateUploadContent(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(message("Upload must contain between 1 byte and 20 MiB", "Le fichier doit contenir entre 1 octet et 20 MiB"));
  }
  const extension = filename.split(".").at(-1).toLowerCase();
  const begins = bytes => buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));
  const ascii = (offset, text) => buffer.subarray(offset, offset + text.length).toString("ascii") === text;
  const valid = {
    png: () => begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpg: () => begins([0xff, 0xd8, 0xff]), jpeg: () => begins([0xff, 0xd8, 0xff]),
    webp: () => ascii(0, "RIFF") && ascii(8, "WEBP"),
    gif: () => ascii(0, "GIF87a") || ascii(0, "GIF89a"),
    mp3: () => ascii(0, "ID3") || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0),
    ogg: () => ascii(0, "OggS"),
    wav: () => ascii(0, "RIFF") && ascii(8, "WAVE"),
    webm: () => begins([0x1a, 0x45, 0xdf, 0xa3]),
    mp4: () => ascii(4, "ftyp"),
    pdf: () => ascii(0, "%PDF-")
  }[extension];
  if (!valid?.()) throw new Error(message(`File contents do not match the ${extension} extension`, `Le contenu du fichier ne correspond pas à l'extension ${extension}`));
}

export function decodeUploadBase64(input) {
  if (typeof input !== "string") throw new Error(message("Base64 upload data must be a string", "Les données base64 doivent être une chaîne"));
  const marker = input.startsWith("data:") ? /^data:[^,;]+;base64,/.exec(input) : null;
  if (input.startsWith("data:") && !marker) throw new Error(message("Only base64 data URLs are supported", "Seules les URL de données base64 sont acceptées"));
  const encoded = marker ? input.slice(marker[0].length) : input;
  if (encoded.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) throw new Error(message("File too large (20 MiB maximum)", "Fichier trop volumineux (20 MiB maximum)"));
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error(message("Invalid base64 upload data", "Données base64 invalides"));
  }
  const result = Buffer.from(encoded, "base64");
  if (result.length > MAX_UPLOAD_BYTES) throw new Error(message("File too large (20 MiB maximum)", "Fichier trop volumineux (20 MiB maximum)"));
  return result;
}

function validateRemoteUrl(candidate, origins) {
  let url;
  try { url = new URL(candidate); } catch { throw new Error(message("Invalid remote upload URL", "URL de téléversement distant invalide")); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(message("Remote upload URLs must use HTTPS without credentials or fragments", "Les URL distantes doivent utiliser HTTPS, sans identifiants ni fragment"));
  }
  if (!origins.has(url.origin)) throw new Error(message(`Remote upload origin is not allowed: ${url.origin}`, `Origine de téléversement distant non autorisée : ${url.origin}`));
  const address = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(address) && !isPublicAddress(address)) throw new Error(message("Remote upload cannot access private or reserved IPs", "Le téléversement distant ne peut pas accéder à des IP privées ou réservées"));
  return url;
}

function publicLookup(hostname, options, callback) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new Error(message("Remote upload DNS resolved to a private or reserved address", "Le DNS distant a résolu une adresse privée ou réservée")));
    }
    const choice = addresses.find(entry => entry.family === 4) || addresses[0];
    if (options?.all) callback(null, [choice]);
    else callback(null, choice.address, choice.family);
  });
}

/** HTTPS-only downloads, opt-in origins, DNS checks on the actual connection, bounded streaming. */
export async function downloadPublicFile(candidate, {
  allowedOrigins = (process.env.UPLOAD_ALLOWED_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean),
  redirects = 0
} = {}) {
  if (!allowedOrigins.length) throw new Error(message("Remote URL uploads are disabled; configure UPLOAD_ALLOWED_ORIGINS or use base64", "Le téléversement par URL est désactivé ; configurer UPLOAD_ALLOWED_ORIGINS ou utiliser base64"));
  const url = validateRemoteUrl(candidate, new Set(allowedOrigins));
  if (redirects > MAX_REDIRECTS) throw new Error(message("Too many upload redirects", "Trop de redirections de téléversement"));
  let timeout;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      lookup: publicLookup,
      headers: { accept: "image/*, audio/*, video/*, application/pdf, application/octet-stream" }
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location) return reject(new Error(message("Upload redirect has no Location header", "La redirection de téléversement n'a pas d'en-tête Location")));
        try { resolve(downloadPublicFile(new URL(location, url).href, { allowedOrigins, redirects: redirects + 1 })); }
        catch (error) { reject(error); }
        return;
      }
      if (status !== 200) { response.destroy(); return reject(new Error(message(`Remote upload failed (HTTP ${status})`, `Échec du téléversement distant (HTTP ${status})`))); }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        response.destroy(); return reject(new Error(message("Remote upload exceeds the 20 MiB limit", "Le téléversement distant dépasse la limite de 20 MiB")));
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) req.destroy(new Error(message("Remote upload exceeds the 20 MiB limit", "Le téléversement distant dépasse la limite de 20 MiB")));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("close", () => { if (!response.complete) reject(new Error(message("Remote upload response was interrupted", "La réponse du téléversement distant a été interrompue"))); });
      response.on("end", () => {
        if (size > MAX_UPLOAD_BYTES) reject(new Error(message("Remote upload exceeds the 20 MiB limit", "Le téléversement distant dépasse la limite de 20 MiB")));
        else resolve(Buffer.concat(chunks, size));
      });
    });
    timeout = setTimeout(() => req.destroy(new Error(message("Remote upload timed out", "Délai de téléversement distant dépassé"))), DOWNLOAD_TIMEOUT_MS);
    timeout.unref();
    req.on("error", reject);
    req.end();
  }).finally(() => clearTimeout(timeout));
}
