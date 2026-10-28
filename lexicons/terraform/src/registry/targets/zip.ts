/**
 * The zip of an attested module archive (chant#4605, terragucci#1299 ruling
 * A). Artifactory takes a module only as a zip and Nexus recommends one, so
 * their targets upload the same files the bucket registry's `.tar.gz`
 * carries, at the same paths with the same modes, repacked as a zip. Nothing
 * is added to or dropped from the module.
 *
 * The repack is deterministic: entries keep the tarball's order and mtimes,
 * so one archive always gives the same zip bytes. The zip's archive comment
 * carries the attested content digest and the revision
 * (`chant-module content=sha256:<hex> revision=<sha>`), which is how a
 * target's `held` tells, from the zip a host gives back, which attested
 * archive it was made from. A zip with no such comment (one uploaded by
 * hand) is judged by its own digest, so it never passes for the release's.
 *
 * No zip64: an archive past 4 GiB or 65535 entries is refused, far above
 * either host's limit (Nexus takes 100 MB per module).
 */
import { deflateRawSync, gunzipSync, inflateRawSync } from "node:zlib";
import { PublishTargetError } from "@intentius/chant/lifecycle/release-publish";

/** One entry of a module tarball. */
export interface ModuleArchiveEntry {
  path: string;
  type: "file" | "dir";
  mode: number;
  /** Seconds since the epoch. */
  mtime: number;
  data: Buffer;
}

const field = (b: Buffer, at: number, len: number): string => {
  const raw = b.subarray(at, at + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf-8");
};
const octal = (b: Buffer, at: number, len: number): number => parseInt(field(b, at, len).trim() || "0", 8);

function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = parseInt(data.subarray(at, space).toString("utf-8"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(space + 1, at + len - 1).toString("utf-8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

const invalid = (message: string) => new PublishTargetError("publish-archive-invalid", message, "Publish the .tar.gz the bucket registry serves, with the module's files at its root.");

/**
 * The entries of a module's gzip tarball (ustar, pax and GNU long names), with
 * `./` cut from each path. A link or a device in the archive is refused: a
 * zip of the module could not carry it as the tarball does.
 */
export function moduleArchiveEntries(archive: Uint8Array): ModuleArchiveEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw invalid("the module archive is not a gzip tarball");
  }
  const out: ModuleArchiveEntry[] = [];
  let at = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const flag = String.fromCharCode(header[156] || 0x30);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (flag === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (flag === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (flag === "g") continue;
    const prefix = field(header, 345, 155);
    const raw = pax.path ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const mtime = pax.mtime ? Math.floor(Number(pax.mtime)) : octal(header, 136, 12);
    pax = {};
    longName = undefined;
    const path = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (!path || path === ".") continue;
    if (path.startsWith("/") || path.split("/").includes("..")) throw invalid(`the module archive holds ${raw}, outside its root`);
    const type = flag === "0" || flag === "\0" || flag === "7" ? "file" : flag === "5" ? "dir" : undefined;
    if (!type) throw invalid(`the module archive holds ${path}, which is not a regular file or a directory; a zip of the module cannot carry it`);
    out.push({ path, type, mode: octal(header, 100, 8) & 0o7777, mtime, data: type === "file" ? Buffer.from(data) : Buffer.alloc(0) });
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The CRC-32 a zip entry carries. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, as a zip entry keeps them, in UTC and clamped to 1980. */
function dosTime(seconds: number): { time: number; date: number } {
  const d = new Date(Math.max(seconds * 1000, Date.UTC(1980, 0, 1)));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** The archive comment that names the attested archive a zip was made from. */
export const ZIP_COMMENT_PREFIX = "chant-module";

export const moduleZipComment = (content: string, revision?: string): string => `${ZIP_COMMENT_PREFIX} content=${content}${revision ? ` revision=${revision}` : ""}`;

/** The content and revision a zip's archive comment names, when it is one {@link moduleZipComment} wrote. */
export function readModuleZipComment(comment: string): { content: string; revision?: string } | undefined {
  if (!comment.startsWith(`${ZIP_COMMENT_PREFIX} `)) return undefined;
  const content = /(?:^| )content=(sha256:[0-9a-f]{64})(?: |$)/.exec(comment)?.[1];
  if (!content) return undefined;
  const revision = /(?:^| )revision=([^ ]+)(?: |$)/.exec(comment)?.[1];
  return { content, ...(revision ? { revision } : {}) };
}

/** A zip of the given entries, with `comment` as its archive comment. Files are deflated. */
export function zipOf(entries: readonly ModuleArchiveEntry[], comment = ""): Buffer {
  if (entries.length > 0xffff) throw invalid(`the module archive holds ${entries.length} entries; a zip without zip64 holds 65535`);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.type === "dir" ? `${e.path}/` : e.path, "utf-8");
    const data = e.type === "file" ? e.data : Buffer.alloc(0);
    const packed = e.type === "file" ? deflateRawSync(data, { level: 9 }) : Buffer.alloc(0);
    const method = e.type === "file" ? 8 : 0;
    const crc = crc32(data);
    const { time, date } = dosTime(e.mtime);
    if (packed.length > 0xfffffffe || data.length > 0xfffffffe || offset > 0xfffffffe) throw invalid("the module archive is past 4 GiB; a zip without zip64 holds less");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const unixMode = (e.type === "dir" ? 0o040000 : 0o100000) | (e.mode & 0o7777 || (e.type === "dir" ? 0o755 : 0o644));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((unixMode << 16) | (e.type === "dir" ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const note = Buffer.from(comment, "utf-8");
  if (note.length > 0xffff) throw invalid("the zip comment is longer than a zip carries");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...locals, cd, end, note]);
}

/**
 * The zip a hosted target uploads for an attested archive: its entries,
 * repacked, with the content digest and revision in the archive comment.
 */
export function moduleZip(archive: Uint8Array, content: string, revision?: string): Buffer {
  return zipOf(moduleArchiveEntries(archive), moduleZipComment(content, revision));
}

/** A zip read back: its archive comment and its entries' paths, modes and bytes. */
export interface ReadZip {
  comment: string;
  entries: { path: string; dir: boolean; mode: number; data: Buffer }[];
}

/** Reads a zip's central directory and entries. Throws on bytes that are not a zip. */
export function readZip(bytes: Uint8Array): ReadZip {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive: no end of central directory");
  const count = b.readUInt16LE(end + 10);
  const cdOffset = b.readUInt32LE(end + 16);
  const comment = b.subarray(end + 22, end + 22 + b.readUInt16LE(end + 20)).toString("utf-8");
  const entries: ReadZip["entries"] = [];
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(at) !== 0x02014b50) throw new Error("not a zip archive: a bad central directory entry");
    const method = b.readUInt16LE(at + 10);
    const csize = b.readUInt32LE(at + 20);
    const nameLen = b.readUInt16LE(at + 28);
    const extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32);
    const external = b.readUInt32LE(at + 38);
    const local = b.readUInt32LE(at + 42);
    const name = b.subarray(at + 46, at + 46 + nameLen).toString("utf-8");
    at += 46 + nameLen + extraLen + commentLen;
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error(`not a zip archive: no local header for ${name}`);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const packed = b.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(packed) : method === 8 ? inflateRawSync(packed) : undefined;
    if (!data) throw new Error(`${name}: zip method ${method} is not read here`);
    const dir = name.endsWith("/");
    entries.push({ path: dir ? name.slice(0, -1) : name, dir, mode: (external >>> 16) & 0o7777, data });
  }
  return { comment, entries };
}

const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b;

/**
 * The content a module archive a host gave back carries, as `held` reports
 * it: the attested digest a chant zip's comment names; for a gzip tarball,
 * the digest of its uncompressed bytes, as the bucket registry keeps it; for
 * any other bytes, their own digest.
 */
export function heldContentOf(bytes: Uint8Array, digest: (b: Uint8Array) => string): { content: string; revision?: string } {
  if (isZip(bytes)) {
    try {
      const named = readModuleZipComment(readZip(bytes).comment);
      if (named) return named;
    } catch {
      // Not a zip after all: judged by its own digest below.
    }
  } else if (isGzip(bytes)) {
    try {
      return { content: digest(gunzipSync(bytes)) };
    } catch {
      // A broken gzip: judged by its own digest below.
    }
  }
  return { content: digest(bytes) };
}
