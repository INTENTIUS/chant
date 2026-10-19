/**
 * The two file sets the pull requests copy over the base (#4085 section 1):
 * overlays/change/ and overlays/fix/, each laid out as the repo is, with
 * `@CYCLE@` filled in with the cycle's number.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Round } from "../steps.js";

export const OVERLAYS_DIR = join(import.meta.dirname, "..", "overlays");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** The round's files, repo-relative path to content. */
export function overlayFiles(round: Round, cycle: number, root: string = OVERLAYS_DIR): Record<string, string> {
  const dir = join(root, round);
  const files: Record<string, string> = {};
  for (const path of walk(dir)) {
    files[relative(dir, path).split(sep).join("/")] = readFileSync(path, "utf8").replace(/@CYCLE@/g, String(cycle));
  }
  return files;
}
