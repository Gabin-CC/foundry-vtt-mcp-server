/** Incremental ChatMessage snapshots for a single authenticated Foundry socket. */

export function chatTimestamp(message) {
  const value = message?.timestamp ?? message?._stats?.createdTime;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function compareChatMessages(a, b) {
  return (chatTimestamp(a) ?? -1) - (chatTimestamp(b) ?? -1) ||
    (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
}

/**
 * Foundry's database-get socket query does not reliably honor comparison operators.
 * A full read primes this cache; subsequent socket broadcasts keep it current.
 * Full reads are still required periodically to recover from missed broadcasts.
 */
export class ChatHistory {
  constructor() {
    this.messages = null;
    this.refreshedAt = 0;
    this.invalidated = false;
    this.pending = null;
  }

  beginRefresh() { this.pending = []; }

  completeRefresh(messages, now = Date.now()) {
    if (!Array.isArray(messages)) throw new TypeError("Foundry chat history must be an array");
    this.messages = new Map(messages.filter(m => typeof m?._id === "string").map(m => [m._id, m]));
    this.refreshedAt = now;
    this.invalidated = false;
    for (const event of this.pending || []) this.apply(event);
    this.pending = null;
  }

  failRefresh() { this.pending = null; this.invalidated = true; }
  clear() { this.messages = null; this.pending = null; this.invalidated = false; }

  isFresh(maxAgeMs, now = Date.now()) {
    return this.messages !== null && !this.invalidated && now - this.refreshedAt < maxAgeMs;
  }

  since(threshold) {
    return [...(this.messages?.values() || [])]
      .filter(m => { const t = chatTimestamp(m); return t !== null && t >= threshold; })
      .sort(compareChatMessages);
  }

  observe(event) {
    if (event?.type !== "ChatMessage" || !["create", "update", "delete"].includes(event.action)) return;
    if (this.pending) this.pending.push(event);
    else if (this.messages) this.apply(event);
  }

  apply(event) {
    if (!Array.isArray(event.result)) { this.invalidated = true; return; }
    for (const item of event.result) {
      const id = typeof item === "string" ? item : item?._id;
      if (typeof id !== "string") { this.invalidated = true; continue; }
      if (event.action === "delete") { this.messages.delete(id); continue; }
      if (!item || typeof item !== "object") { this.invalidated = true; continue; }
      const previous = this.messages.get(id);
      if (event.action === "update" && !previous) { this.invalidated = true; continue; }
      this.messages.set(id, event.action === "update" ? { ...previous, ...item } : item);
    }
  }
}
