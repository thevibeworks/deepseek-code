// pi's OutputAccumulator shape (Round 4 delta #6): rolling tail in
// memory, spill to a file the MOMENT the limit is exceeded during
// streaming, footer with the full-output path. Memory stays bounded no
// matter how much a command prints.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SPILL_BYTES } from "./truncate";

const EDGE_BYTES = 2_000;

let spillCounter = 0;

export type AccumulatedOutput =
  | { spilled: false; text: string }
  | { spilled: true; text: string; path: string; bytes: number };

export class OutputAccumulator {
  private buffered = "";
  private head = "";
  private tail = "";
  private bytes = 0;
  private path: string | null = null;

  constructor(
    private spillDir: string | undefined,
    private label: string,
  ) {}

  add(chunk: string): void {
    if (chunk === "") return;
    this.bytes += Buffer.byteLength(chunk, "utf8");
    if (this.path !== null) {
      appendFileSync(this.path, chunk);
      this.tail = (this.tail + chunk).slice(-EDGE_BYTES);
      return;
    }
    // Buffer first so a single oversize chunk still contributes the head.
    this.buffered += chunk;
    if (this.spillDir !== undefined && this.bytes > SPILL_BYTES) {
      mkdirSync(this.spillDir, { recursive: true });
      this.path = join(this.spillDir, `${this.label}-${++spillCounter}.txt`);
      appendFileSync(this.path, this.buffered);
      this.head = this.buffered.slice(0, EDGE_BYTES);
      this.tail = this.buffered.slice(-EDGE_BYTES);
      this.buffered = "";
    }
  }

  finalize(): AccumulatedOutput {
    if (this.path === null) return { spilled: false, text: this.buffered };
    // Cut the preview edges at line boundaries so no partial lines leak.
    let head = this.head;
    const hc = head.lastIndexOf("\n");
    if (hc > 0) head = head.slice(0, hc);
    let tail = this.tail;
    const tc = tail.indexOf("\n");
    if (tc >= 0) tail = tail.slice(tc + 1);
    return {
      spilled: true,
      text: head + "\n[...]\n" + tail,
      path: this.path,
      bytes: this.bytes,
    };
  }
}

/** Drain a byte stream into an accumulator, decoding incrementally. */
export async function drainStream(
  stream: ReadableStream<Uint8Array>,
  acc: OutputAccumulator,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    acc.add(decoder.decode(chunk, { stream: true }));
  }
  acc.add(decoder.decode());
}
