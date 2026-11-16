/**
 * Release intent files (#5159): `.chant/release/*.md` at the repository
 * root, each naming the members a change releases and the level it bumps
 * them by, with a summary for the release notes.
 *
 * ```md
 * ---
 * core: minor
 * lexicon-aws: patch
 * ---
 * The core reads its config once at start.
 * ```
 *
 * A key is a member's name, as `chant release changed` lists it (or its
 * full ledger name, such as `npm/core`), or `*` for every member and for a
 * project that is no workspace member. A value is `major`, `minor` or
 * `patch`. `README.md` in the directory is not an intent.
 *
 * Files are read from a commit's tree, never from the working tree. An
 * intent is the file's path together with the commit that added it, so a
 * file deleted and written again is a new intent. A cut records the
 * intents it consumed on its cut line (`ReleaseCut.intents`), and a later
 * release of the same member skips them: no commit to the branch is needed
 * to retire one, so the tree never has to hold the version being released.
 */

import { execFileSync } from "node:child_process";
import type { ReleaseCut, ReleaseCutIntent } from "./release-store";

export type ReleaseBumpLevel = "major" | "minor" | "patch";

/** Where intent files live, from the repository root. */
export const INTENT_DIR = ".chant/release";

const LEVELS: readonly ReleaseBumpLevel[] = ["patch", "minor", "major"];

/** The higher of two levels; null is lower than any. */
export function maxBump(a: ReleaseBumpLevel | null, b: ReleaseBumpLevel | null): ReleaseBumpLevel | null {
  if (a === null) return b;
  if (b === null) return a;
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

/** An intent file that can't be read. */
export class ReleaseIntentError extends Error {
  readonly code = "release-intent-invalid";
  constructor(
    readonly path: string,
    why: string,
  ) {
    super(`the intent file ${path} ${why}`);
    this.name = "ReleaseIntentError";
  }
}

/** One intent file, read at a commit. */
export interface ReleaseIntent {
  /** From the repository root. */
  path: string;
  /** The full sha of the commit that added it. */
  added: string;
  /** Member name (or `*`) to level, in the file's order. */
  members: Map<string, ReleaseBumpLevel>;
  /** The text after the front matter, trimmed. */
  summary: string;
}

/** The members and summary of an intent file's text. Throws {@link ReleaseIntentError}. */
export function parseIntent(path: string, text: string): { members: Map<string, ReleaseBumpLevel>; summary: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new ReleaseIntentError(path, "does not start with a --- line opening its front matter");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) throw new ReleaseIntentError(path, "has no --- line closing its front matter");
  const members = new Map<string, ReleaseBumpLevel>();
  for (const raw of lines.slice(1, end)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^("([^"]+)"|'([^']+)'|([^:\s][^:]*?))\s*:\s*("?|'?)([A-Za-z]+)\5\s*$/.exec(line);
    if (!m) throw new ReleaseIntentError(path, `has a front matter line that is not <member>: major|minor|patch: ${JSON.stringify(line)}`);
    const name = (m[2] ?? m[3] ?? m[4])!.trim();
    const level = m[6]!.toLowerCase();
    if (!(LEVELS as readonly string[]).includes(level)) throw new ReleaseIntentError(path, `gives ${name} the level ${m[6]}, which is not major, minor or patch`);
    if (members.has(name)) throw new ReleaseIntentError(path, `names ${name} twice`);
    members.set(name, level as ReleaseBumpLevel);
  }
  if (members.size === 0) throw new ReleaseIntentError(path, "names no member in its front matter");
  return { members, summary: lines.slice(end + 1).join("\n").trim() };
}

function git(top: string, args: string[]): string {
  return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** Every intent file in `commit`'s tree, sorted by path. Throws {@link ReleaseIntentError} for one that can't be read. */
export function readIntents(top: string, commit: string): ReleaseIntent[] {
  const listed = git(top, ["ls-tree", "--name-only", "-z", commit, "--", `${INTENT_DIR}/`])
    .split("\0")
    .filter((p) => p.endsWith(".md") && !/(^|\/)README\.md$/i.test(p) && p.slice(INTENT_DIR.length + 1).indexOf("/") < 0)
    .sort();
  return listed.map((path) => {
    const { members, summary } = parseIntent(path, git(top, ["show", `${commit}:${path}`]));
    const added = git(top, ["log", "-1", "--diff-filter=A", "--format=%H", commit, "--", path]).trim();
    return { path, added: added || commit, members, summary };
  });
}

/** The key a consumed intent is known by. */
export const intentKey = (i: { path: string; added: string }): string => `${i.path}@${i.added}`;

/** The intents the member's cuts consumed, by {@link intentKey}. */
export function consumedIntents(cuts: readonly ReleaseCut[]): Set<string> {
  const out = new Set<string>();
  for (const c of cuts) for (const i of c.intents ?? []) out.add(intentKey(i));
  return out;
}

/** The level `intent` gives a member known by any of `names`, or null when it names none of them. */
export function intentLevel(intent: ReleaseIntent, names: readonly string[]): ReleaseBumpLevel | null {
  let level: ReleaseBumpLevel | null = null;
  for (const n of [...names, "*"]) level = maxBump(level, intent.members.get(n) ?? null);
  return level;
}

/** The intents that name the member (by any of `names`) and that none of its cuts consumed, as a cut records them. */
export function pendingIntents(intents: readonly ReleaseIntent[], names: readonly string[], consumed: ReadonlySet<string>): Array<ReleaseCutIntent & { summary: string }> {
  const out: Array<ReleaseCutIntent & { summary: string }> = [];
  for (const i of intents) {
    const bump = intentLevel(i, names);
    if (bump === null || consumed.has(intentKey(i))) continue;
    out.push({ path: i.path, added: i.added, bump, summary: i.summary });
  }
  return out;
}

/** Release notes from intent summaries (#5159): one item each, the highest level first, under one heading. Empty when no summary has text. */
export function intentNotes(intents: ReadonlyArray<{ bump: ReleaseBumpLevel; summary: string }>): string {
  const listed = intents.filter((i) => i.summary.length > 0).sort((a, b) => LEVELS.indexOf(b.bump) - LEVELS.indexOf(a.bump));
  if (listed.length === 0) return "";
  const item = (s: string): string =>
    s
      .split("\n")
      .map((l, n) => (n === 0 ? `- ${l}` : l.length > 0 ? `  ${l}` : ""))
      .join("\n");
  return ["### Highlights", "", ...listed.map((i) => item(i.summary))].join("\n");
}
