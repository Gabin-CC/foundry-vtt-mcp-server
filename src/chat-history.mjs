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
    this.sorted = [];
    this.refreshedAt = 0;
    this.invalidated = false;
    this.pending = null;
  }

  beginRefresh() { this.pending = []; }

  completeRefresh(messages, now = Date.now()) {
    if (!Array.isArray(messages)) throw new TypeError("Foundry chat history must be an array");
    this.messages = new Map(messages.filter(m => typeof m?._id === "string").map(m => [m._id, m]));
    this.sorted = [...this.messages.values()].sort(compareChatMessages);
    this.refreshedAt = now;
    this.invalidated = false;
    for (const event of this.pending || []) this.apply(event);
    this.pending = null;
  }

  failRefresh() { this.pending = null; this.invalidated = true; }
  clear() { this.messages = null; this.sorted = []; this.pending = null; this.invalidated = false; }

  isFresh(maxAgeMs, now = Date.now()) {
    return this.messages !== null && !this.invalidated && now - this.refreshedAt < maxAgeMs;
  }

  since(threshold) {
    // The sorted index makes a quiet 2,000+ message world cheap to poll:
    // binary search rather than scanning and sorting every history entry.
    let low = 0, high = this.sorted.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((chatTimestamp(this.sorted[middle]) ?? -1) < threshold) low = middle + 1;
      else high = middle;
    }
    return this.sorted.slice(low);
  }

  remove(id) {
    const index = this.sorted.findIndex(message => message._id === id);
    if (index >= 0) this.sorted.splice(index, 1);
    this.messages.delete(id);
  }

  insert(message) {
    let low = 0, high = this.sorted.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (compareChatMessages(this.sorted[middle], message) < 0) low = middle + 1;
      else high = middle;
    }
    this.sorted.splice(low, 0, message);
    this.messages.set(message._id, message);
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
      if (event.action === "delete") { this.remove(id); continue; }
      if (!item || typeof item !== "object") { this.invalidated = true; continue; }
      const previous = this.messages.get(id);
      if (event.action === "update" && !previous) { this.invalidated = true; continue; }
      if (previous) this.remove(id);
      this.insert(event.action === "update" ? { ...previous, ...item } : item);
    }
  }
}
