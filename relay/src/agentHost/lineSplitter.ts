// Newline framing without quadratic work: a long line arriving in many small
// chunks used to be re-concatenated and re-scanned from its start on every
// chunk. These keep the pieces of an unfinished line in a list and only look
// for a newline in the chunk that just arrived.

/** For text streams (the socket, both sides). */
export class StringLineSplitter {
  private parts: string[] = [];
  private partsLength = 0;

  /** Characters held for a line not finished yet. */
  get pendingLength(): number {
    return this.partsLength;
  }

  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      if (nl < 0) break;
      const piece = chunk.slice(start, nl);
      if (this.parts.length > 0) {
        this.parts.push(piece);
        lines.push(this.parts.join(""));
        this.parts = [];
        this.partsLength = 0;
      } else {
        lines.push(piece);
      }
      start = nl + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.slice(start);
      this.parts.push(rest);
      this.partsLength += rest.length;
    }
    return lines;
  }
}

export interface PositionedLine {
  readonly line: string;
  /** Byte position of the line's first byte. */
  readonly start: number;
  /** Byte position just past its newline. */
  readonly end: number;
}

/** For bytes read from a file at a known position (the log reader). */
export class BufferLineSplitter {
  private parts: Buffer[] = [];
  private partsLength = 0;

  /** `position`: byte position of the first byte that will be pushed. */
  constructor(private pos: number) {}

  /** Position just past the last complete line returned. */
  get position(): number {
    return this.pos;
  }

  push(chunk: Buffer): PositionedLine[] {
    const lines: PositionedLine[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) break;
      const piece = chunk.subarray(start, nl);
      const bytes = this.partsLength > 0 ? Buffer.concat([...this.parts, piece]) : piece;
      const length = bytes.length + 1;
      lines.push({ line: bytes.toString("utf8"), start: this.pos, end: this.pos + length });
      this.pos += length;
      this.parts = [];
      this.partsLength = 0;
      start = nl + 1;
    }
    if (start < chunk.length) {
      // Copied: the caller may reuse its read buffer.
      const rest = Buffer.from(chunk.subarray(start));
      this.parts.push(rest);
      this.partsLength += rest.length;
    }
    return lines;
  }
}
