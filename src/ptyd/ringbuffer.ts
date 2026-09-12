/**
 * Fixed-capacity byte ring for raw PTY output.
 *
 * This is the fallback path for screen restore when `reviveScreen` is off, and
 * a debugging aid otherwise. It never grows, so a session that prints gigabytes
 * costs the same memory as one that prints nothing.
 */
export class RingBuffer {
  private readonly buf: Buffer;
  private start = 0;
  private length = 0;

  constructor(readonly capacity: number) {
    this.buf = Buffer.alloc(capacity);
  }

  get size(): number {
    return this.length;
  }

  write(chunk: Buffer): void {
    if (chunk.length === 0) return;

    // A chunk bigger than the whole ring: keep only its tail.
    if (chunk.length >= this.capacity) {
      chunk.copy(this.buf, 0, chunk.length - this.capacity);
      this.start = 0;
      this.length = this.capacity;
      return;
    }

    const end = (this.start + this.length) % this.capacity;
    const firstPart = Math.min(chunk.length, this.capacity - end);
    chunk.copy(this.buf, end, 0, firstPart);
    if (firstPart < chunk.length) {
      chunk.copy(this.buf, 0, firstPart);
    }

    const overflow = this.length + chunk.length - this.capacity;
    if (overflow > 0) {
      this.start = (this.start + overflow) % this.capacity;
      this.length = this.capacity;
    } else {
      this.length += chunk.length;
    }
  }

  /** Contents oldest-first, as a fresh contiguous buffer. */
  read(): Buffer {
    if (this.length === 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(this.length);
    const firstPart = Math.min(this.length, this.capacity - this.start);
    this.buf.copy(out, 0, this.start, this.start + firstPart);
    if (firstPart < this.length) {
      this.buf.copy(out, firstPart, 0, this.length - firstPart);
    }
    return out;
  }

  clear(): void {
    this.start = 0;
    this.length = 0;
  }
}
