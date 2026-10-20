/**
 * The surface-snapshot check for the lexicons a pull request touches (#2814).
 *
 * A lexicon whose `validate` sets `checkSurfaceSnapshot` (aws, azure, k8s,
 * sql) is already compared against its `surface.snapshot.json` on every PR by
 * the `validate` job. The others (docker, fly, fountain, gcp, github, gitlab)
 * were compared only by the weekly lexicon-upgrade run, so a PR could change
 * one's surface without updating the snapshot and the drift showed up days
 * later. This checks those, for the lexicons the PR changed.
 *
 * Some of them generate from a moving upstream (fly from the live Machines
 * OpenAPI, github from its live REST description), so the head's generated
 * surface can differ from the snapshot for reasons that are not the PR's. The
 * check therefore fails only when the PR changes the drift: when the head's
 * drift (fresh surface against committed snapshot) differs from the base's
 * drift, both generated here from the same fetched spec. Drift that base has
 * too is reported and passes; the weekly job proposes accepting it.
 *
 * Usage: tsx scripts/check-changed-surfaces.ts [--base <ref>] [--head <ref>]
 * Base defaults to origin/main and head to HEAD. Exit 1 when a lexicon's
 * surface changed without its snapshot, 0 otherwise.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFreshSurface, SNAPSHOT_FILENAME } from "../packages/core/src/codegen/lexicon-regen";
import {
  diffSurface,
  formatDelta,
  parseSnapshot,
  type SurfaceDelta,
  type SurfaceSnapshot,
} from "../packages/core/src/codegen/surface-snapshot";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The lexicons a change touches, from its changed paths: any file under
 * `lexicons/<name>/src/` other than generated output, or the snapshot itself.
 */
export function touchedLexicons(paths: string[]): string[] {
  const names = new Set<string>();
  for (const p of paths) {
    const m = /^lexicons\/([^/]+)\/(src\/(.+)|surface\.snapshot\.json)$/.exec(p);
    if (!m) continue;
    if (m[3] !== undefined && m[3].startsWith("generated/")) continue;
    names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Whether `validate` already compares this lexicon's surface on PRs, because
 * its config sets `checkSurfaceSnapshot` (the CI validate job arms the gate).
 */
export function gatedByValidate(validateSource: string): boolean {
  return /checkSurfaceSnapshot\s*:\s*(true|"always")/.test(validateSource);
}

function isEmpty(delta: SurfaceDelta): boolean {
  return (
    delta.added.length === 0 &&
    delta.removed.length === 0 &&
    delta.changed.length === 0 &&
    delta.renamed.length === 0
  );
}

export type Verdict = "matches" | "upstream-drift" | "changed-without-snapshot";

/**
 * The PR passes when its drift is empty, or is the same drift base has. Any
 * other drift is a surface change the PR made without updating the snapshot.
 */
export function verdict(headDrift: SurfaceDelta, baseDrift: SurfaceDelta | null): Verdict {
  if (isEmpty(headDrift)) return "matches";
  if (baseDrift && JSON.stringify(headDrift) === JSON.stringify(baseDrift)) return "upstream-drift";
  return "changed-without-snapshot";
}

function git(args: string[], cwd = root): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function generate(lexiconDir: string): void {
  execFileSync("npm", ["run", "generate"], { cwd: lexiconDir, stdio: ["ignore", "ignore", "inherit"] });
}

function readSnapshot(lexiconDir: string): SurfaceSnapshot | null {
  const path = join(lexiconDir, SNAPSHOT_FILENAME);
  return existsSync(path) ? parseSnapshot(readFileSync(path, "utf-8")) : null;
}

/** Generate the lexicon in `checkout` and diff it against that checkout's snapshot. */
function driftIn(checkout: string, name: string): SurfaceDelta {
  const dir = join(checkout, "lexicons", name);
  const snapshot = readSnapshot(dir);
  generate(dir);
  const fresh = extractFreshSurface(dir);
  if (!snapshot || !fresh) throw new Error(`lexicons/${name}: no snapshot or no generated surface in ${checkout}`);
  return diffSurface(snapshot, fresh);
}

/** A detached worktree of `ref` that resolves dependencies through this checkout's node_modules. */
function worktreeAt(ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-surface-base-"));
  rmSync(dir, { recursive: true });
  git(["worktree", "add", "--quiet", "--detach", dir, ref]);
  for (const rel of ["node_modules", "packages/core/node_modules"]) {
    if (existsSync(join(root, rel)) && !existsSync(join(dir, rel))) symlinkSync(join(root, rel), join(dir, rel));
  }
  return dir;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const base = flag("--base", "origin/main");
  const head = flag("--head", "HEAD");

  const changed = git(["diff", "--name-only", `${base}...${head}`]).split("\n").filter(Boolean);
  const candidates = touchedLexicons(changed).filter((name) => {
    const dir = join(root, "lexicons", name);
    if (!existsSync(join(dir, SNAPSHOT_FILENAME))) return false;
    const validate = join(dir, "src", "validate.ts");
    return !(existsSync(validate) && gatedByValidate(readFileSync(validate, "utf-8")));
  });

  if (candidates.length === 0) {
    console.error("No changed lexicon with a surface snapshot outside the validate gate.");
    return;
  }

  let baseCheckout: string | null = null;
  let failed = false;
  try {
    for (const name of candidates) {
      const headDrift = driftIn(root, name);
      let baseDrift: SurfaceDelta | null = null;
      if (!isEmpty(headDrift)) {
        baseCheckout ??= worktreeAt(git(["merge-base", base, head]));
        if (existsSync(join(baseCheckout, "lexicons", name, SNAPSHOT_FILENAME))) baseDrift = driftIn(baseCheckout, name);
      }
      const v = verdict(headDrift, baseDrift);
      if (v === "matches") {
        console.error(`lexicons/${name}: surface matches ${SNAPSHOT_FILENAME}`);
      } else if (v === "upstream-drift") {
        console.error(`lexicons/${name}: upstream drift that base has too, not from this change:\n${formatDelta(headDrift)}`);
      } else {
        failed = true;
        console.error(
          `lexicons/${name}: this change moves the surface but not ${SNAPSHOT_FILENAME}:\n${formatDelta(headDrift)}\n` +
            `Run \`npx tsx packages/core/src/cli/main.ts dev surface-diff lexicons/${name} --update-snapshot\` and commit the snapshot.`,
        );
      }
    }
  } finally {
    if (baseCheckout) git(["worktree", "remove", "--force", baseCheckout]);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
