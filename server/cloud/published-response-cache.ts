interface CachedResponse { bytes: Uint8Array<ArrayBuffer>; headers: [string, string][]; status: number; size: number }

/** Bounded per-snapshot cache. Only immutable public JSON responses belong here. */
export class PublishedResponseCache {
  private values = new Map<string, CachedResponse>();
  private pending = new Map<string, Promise<CachedResponse | Response>>();
  private bytes = 0;
  private day = '';
  constructor(private maxBytes = 16 * 1024 * 1024, private maxEntries = 32) {}

  async read(key: string, day: string, produce: () => Promise<Response>): Promise<Response> {
    if (day !== this.day) {
      this.values.clear(); this.pending.clear(); this.bytes = 0; this.day = day;
    }
    const hit = this.values.get(key);
    if (hit) {
      this.values.delete(key); this.values.set(key, hit);
      return this.response(hit);
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = (async () => {
        const response = await produce();
        // Errors must be retryable, and external/streamed/binary routes are not cached.
        if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) return response;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const value: CachedResponse = { bytes, headers: [...response.headers], status: response.status, size: bytes.byteLength };
        if (day === this.day && value.size <= this.maxBytes) {
          while (this.values.size && (this.bytes + value.size > this.maxBytes || this.values.size >= this.maxEntries)) {
            const oldest = this.values.keys().next().value!;
            this.bytes -= this.values.get(oldest)!.size; this.values.delete(oldest);
          }
          if (this.maxEntries > 0) { this.values.set(key, value); this.bytes += value.size; }
        }
        return value;
      })();
      this.pending.set(key, pending);
    }
    try {
      const value = await pending;
      // Concurrent readers must each own a body, including non-cacheable failures.
      return value instanceof Response ? value.clone() : this.response(value);
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
  private response(value: CachedResponse) {
    return new Response(value.bytes, { status: value.status, headers: value.headers });
  }
}
