/**
 * Content hashes for plugins a declaration loads by path (#2547, ws-065).
 *
 * A pin of `{ "path": "plugins/kinds", "integrity": "sha256-..." }` says the
 * plugin directory must hash to that value before chant reads anything from
 * it. `chant workspace pin <path>` prints the value to put there.
 *
 * `integrity` is a Subresource Integrity string: `sha256-`, `sha384-` or
 * `sha512-`, then the base64 of the digest. A directory has no single byte
 * stream to hash, so its digest is taken over a manifest that names every
 * file by its path and its own digest, and a file path is hashed directly:
 *
 * - The files are every regular file under the directory, at any depth, except
 *   anything inside a `node_modules` or `.git` directory.
 * - Each file's digest is the chosen algorithm over its bytes, as they are on
 *   disk: no line-ending change, so a checkout that rewrites line endings
 *   hashes differently from one that does not.
 * - The manifest is one line per file, `<hex digest> <path>\n`, in order of
 *   the path's UTF-16 code units, with `/` as the separator and the path
 *   relative to the directory. The pin is the algorithm over those bytes.
 * - A symbolic link anywhere in the directory is refused: it can point
 *   outside the plugin, and what it points at is not what was pinned.
 *
 * The hash covers the working tree. Build output and untracked files inside
 * the directory change it, so pin a directory that holds only committed files.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type IntegrityAlgorithm = "sha256" | "sha384" | "sha512";

const INTEGRITY = /^(sha(?:256|384|512))-([A-Za-z0-9+/]+={0,2})$/;

/** The algorithm and base64 digest of an `integrity` value, or undefined when it is not one. */
export function parseIntegrity(value: string): { algorithm: IntegrityAlgorithm; digest: string } | undefined {
  const m = INTEGRITY.exec(value);
  return m ? { algorithm: m[1] as IntegrityAlgorithm, digest: m[2] } : undefined;
}

/** Directories a plugin hash never looks inside. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/** Thrown when a path can't be hashed: it is missing, or holds a symbolic link. */
export class PinHashError extends Error {}

function walk(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new PinHashError(`${rel} is a symbolic link, which a pinned plugin may not contain`);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/** The files a directory's hash covers, as paths relative to it, in hash order. */
export function pinnedFiles(dir: string): string[] {
  const files: string[] = [];
  walk(dir, "", files);
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The `integrity` value for the plugin at `abs`: a directory by its manifest, a file by its bytes. */
export function integrityOf(abs: string, algorithm: IntegrityAlgorithm = "sha256"): { integrity: string; files: number } {
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    throw new PinHashError("it does not exist");
  }
  if (stat.isSymbolicLink()) throw new PinHashError("it is a symbolic link, which a pinned plugin may not be");
  if (stat.isFile()) {
    return { integrity: `${algorithm}-${createHash(algorithm).update(readFileSync(abs)).digest("base64")}`, files: 1 };
  }
  const files = pinnedFiles(abs);
  const manifest = files.map((f) => `${createHash(algorithm).update(readFileSync(join(abs, ...f.split("/")))).digest("hex")} ${f}\n`).join("");
  return { integrity: `${algorithm}-${createHash(algorithm).update(manifest, "utf8").digest("base64")}`, files: files.length };
}

export type IntegrityCheck = { ok: true } | { ok: false; message: string };

/** Compare the plugin at `abs` with the `integrity` a pin states. `label` names the plugin in the message. */
export function checkPinIntegrity(abs: string, integrity: string, label: string): IntegrityCheck {
  const parsed = parseIntegrity(integrity);
  if (!parsed) return { ok: false, message: `${label}: integrity ${JSON.stringify(integrity)} is not sha256-, sha384- or sha512- and a base64 digest` };
  let actual: string;
  try {
    actual = integrityOf(abs, parsed.algorithm).integrity;
  } catch (err) {
    if (!(err instanceof PinHashError)) throw err;
    return { ok: false, message: `${label}: can't check its integrity, ${err.message}` };
  }
  if (actual === integrity) return { ok: true };
  return {
    ok: false,
    message:
      `${label}: integrity mismatch, so nothing is read from it. The pin says ${integrity} and the plugin hashes to ${actual}. ` +
      `If the change is intended, run \`chant workspace pin ${label}\` and put the value it prints in the pin; otherwise restore the plugin`,
  };
}
