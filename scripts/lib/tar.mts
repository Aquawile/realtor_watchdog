// Minimal POSIX ustar archive writer/reader (no dependencies). Used to bundle
// many small raw files into one Storage object; entries are stored byte-for-
// byte (no extra compression; the files inside are already gzipped). Bundles
// open with any standard tool: `tar -tvf bundle.tar`.

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

export type TarEntry = { name: string; data: Uint8Array };

function writeString(buf: Uint8Array, offset: number, length: number, value: string) {
  const bytes = enc.encode(value);
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  buf.set(bytes, offset);
}
const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, "0") + "\0";

function header(name: string, size: number, mtime: number): Uint8Array {
  if (enc.encode(name).length > 100) throw new Error(`tar entry name longer than 100 bytes: ${name}`);
  const h = new Uint8Array(BLOCK);
  writeString(h, 0, 100, name);
  writeString(h, 100, 8, octal(0o644, 8));
  writeString(h, 108, 8, octal(0, 8));
  writeString(h, 116, 8, octal(0, 8));
  writeString(h, 124, 12, octal(size, 12));
  writeString(h, 136, 12, octal(mtime, 12));
  writeString(h, 148, 8, "        "); // checksum field counts as spaces while summing
  h[156] = "0".charCodeAt(0); // regular file
  writeString(h, 257, 6, "ustar\0");
  writeString(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

export function createTar(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Uint8Array {
  const names = new Set<string>();
  let total = 2 * BLOCK; // end-of-archive marker
  for (const e of entries) {
    if (names.has(e.name)) throw new Error(`duplicate tar entry: ${e.name}`);
    names.add(e.name);
    total += BLOCK + Math.ceil(e.data.length / BLOCK) * BLOCK;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const e of entries) {
    out.set(header(e.name, e.data.length, mtime), off);
    off += BLOCK;
    out.set(e.data, off);
    off += Math.ceil(e.data.length / BLOCK) * BLOCK;
  }
  return out; // trailing two zero blocks are already zero
}

export function readTar(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break; // end of archive
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    const stored = parseInt(dec.decode(h.subarray(148, 156)).replace(/\0.*$/, "").trim(), 8);
    if (stored !== sum) throw new Error(`corrupt tar header at byte ${off}`);
    const name = dec.decode(h.subarray(0, 100)).split("\0")[0];
    const size = parseInt(dec.decode(h.subarray(124, 136)).replace(/\0.*$/, "").trim(), 8);
    off += BLOCK;
    if (off + size > tar.length) throw new Error(`truncated tar entry ${name}`);
    entries.push({ name, data: tar.slice(off, off + size) });
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
