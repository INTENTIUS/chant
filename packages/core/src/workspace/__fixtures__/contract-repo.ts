/**
 * Helpers the read-contract tests share (#2536): throwaway git repositories,
 * a draft 2020-12 validator, and a fake chant toolchain.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { expect } from "vitest";

/** The chant checkout these tests run in. */
export const REPO = realpathSync(join(import.meta.dirname, "..", "..", "..", "..", ".."));

const scratch: string[] = [];

/** Remove every directory {@link scratchDir} and {@link repo} made. Call it from `afterAll`. */
export function cleanScratch(): void {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function scratchDir(prefix = "chant-contract-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Write `files` under `root`; a value of `{ text, mode }` sets the mode too. */
export function writeFiles(root: string, files: Record<string, string | { text: string; mode: number }>): void {
  for (const [path, value] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof value === "string" ? value : value.text);
    if (typeof value !== "string") chmodSync(full, value.mode);
  }
}

/** A git repository holding `files`, with nothing committed unless `commit` is set. */
export function repo(files: Record<string, string | { text: string; mode: number }>, commit = false): string {
  const root = scratchDir("chant-contract-repo-");
  writeFiles(root, files);
  git(root, "init", "-q");
  if (commit) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
  }
  return root;
}

export function commitAll(root: string, message = "next"): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

const ajv = new Ajv2020({ strict: true, allErrors: true });

/** A validator for `schema`, and an assertion that a document passes it. */
export function contract(schema: object): { validate: ReturnType<typeof ajv.compile>; expectValid(doc: unknown): void } {
  const validate = ajv.compile(schema);
  return {
    validate,
    expectValid(doc) {
      const ok = validate(doc);
      expect(ok, `${JSON.stringify(validate.errors, null, 2)}\n${JSON.stringify(doc, null, 2).slice(0, 2000)}`).toBe(true);
    },
  };
}

export function validSchema(schema: object): boolean {
  return ajv.validateSchema(schema) as boolean;
}

export const declaration = (members: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "acme", schema: 1, ...extra, members }, null, 2);

/**
 * A chant older than `workspace member-run`: it answers `chant graph` in the
 * member's directory with one node per line of the member's `ids.txt`.
 */
export const FAKE_GRAPH_CHANT = `#!/bin/sh
case "$1" in
  graph)
    printf '{"version":1,"nodes":['
    sep=""
    while read -r id; do printf '%s{"id":"%s","kind":"Thing","lexicon":"fake","attrs":{}}' "$sep" "$id"; sep=","; done < ids.txt
    printf '],"edges":[],"groups":{"byLexicon":{}}}\\n'
    ;;
  *) echo "Error: Unknown command: $1" >&2; exit 1 ;;
esac
`;
