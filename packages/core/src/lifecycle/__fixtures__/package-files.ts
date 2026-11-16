/** Package files for the registry targets' tests (#5232): zips and plain tars built in memory, a fake fetch reply, and a publish context. */

import { createHash } from "node:crypto";
import { createRedactor } from "../publish-credentials";
import { zipArchive } from "../release-artifacts";
import type { PublishContext } from "../release-publish";
import { makeRelease, type ReleaseArtifact } from "../release-store";

/** A zip of `files`, in order. */
export function zipOf(files: Record<string, string | Buffer>): Buffer {
  return zipArchive(Object.entries(files).map(([name, v]) => ({ name, bytes: Buffer.isBuffer(v) ? v : Buffer.from(v) })), 315532800);
}

/** A plain ustar tar of `files`, as a `.gem` is. */
export function tarOf(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, v] of Object.entries(files)) {
    const body = Buffer.isBuffer(v) ? v : Buffer.from(v);
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf-8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export const reply = (status: number, body: string | Buffer = "") => ({
  ok: status < 300,
  status,
  headers: { get: () => null },
  text: async () => body.toString(),
  arrayBuffer: async () => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  },
});

/** A publish context for the member at `cwd`, its log lines kept. */
export function publishContext(cwd: string, env: NodeJS.ProcessEnv, artifacts: ReleaseArtifact[] = [], extra: Partial<PublishContext> = {}): PublishContext & { lines: string[] } {
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: artifacts, targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "1.2.0", releaseTag: "release/1.2.0", provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), lines, ...extra };
}

/** The file part of a multipart/form-data body. */
export function formFile(body: Uint8Array, type: string): { field: string; name: string; bytes: Buffer } {
  const boundary = /boundary=(.+)$/.exec(type)![1]!;
  const raw = Buffer.from(body).toString("latin1");
  const part = raw.split(`--${boundary}`)[1]!.replace(/^\r\n/, "");
  const [head, ...rest] = part.split("\r\n\r\n");
  return { field: /name="([^"]+)"/.exec(head!)![1]!, name: /filename="([^"]+)"/.exec(head!)![1]!, bytes: Buffer.from(rest.join("\r\n\r\n").replace(/\r\n$/, ""), "latin1") };
}

/** Run `p` and return the PublishTargetError-like error it throws. */
export async function refusal(p: Promise<unknown>): Promise<Error & { code: string; fix?: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Error && typeof (err as { code?: unknown }).code === "string") return err as Error & { code: string };
    throw err;
  }
  throw new Error("expected a refusal");
}
