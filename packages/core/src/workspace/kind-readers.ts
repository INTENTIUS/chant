/**
 * Reader projects for members of a package's kind (#2874).
 *
 * `chant workspace graph` runs `chant graph` in each member. A `terraform` or
 * `choudoufu` member is a directory of `.tf` files with no chant config, so
 * there is nothing for it to run. The kind's `graph` block in the package's
 * kinds file says how to read one instead: a lexicon and that lexicon's
 * config namespace. For each such member chant writes a reader project of its
 * own, outside the workspace, and the member runs there:
 *
 * - `chant.config.json` declares the lexicon, and puts the kind's config under
 *   the lexicon's key with `{member}`, `{dir}` and `{workspace}` substituted
 *   (`substituteGraphConfig`). The terraform lexicon's config names one root
 *   after the member, at the member's directory, with `moduleRoot` at the
 *   workspace root, so a member that calls `../modules/x` keeps its modules.
 * - `node_modules` links to the `node_modules` directory holding the lexicon
 *   package, found from the workspace root as the kind's pin was. The lexicon
 *   chant loads is then the one the declaration pins.
 *
 * Nothing is written under the workspace, and the projects are removed when
 * the read ends. A lexicon that can't be found where its pin says fails the
 * member with `command-failed` and says what to install; the other members
 * still run.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInstalledPackage, lexiconPackageName, substituteGraphConfig } from "./kinds";
import type { MemberPlan, RunUnit, SkippedEntry } from "./member-commands";

export interface PreparedReaders {
  /** Members whose reader project couldn't be written, with the reason. They fail the run. */
  failed: SkippedEntry[];
  /** Remove every reader project. Safe to call more than once. */
  cleanup(): void;
}

/** The `node_modules` directory an installed package sits in. */
function nodeModulesOf(packageDir: string, name: string): string {
  let dir = packageDir;
  for (let i = 0; i < name.split("/").length; i++) dir = join(dir, "..");
  return dir;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Why a unit's lexicon can't be loaded from `root`, or the `node_modules` to link. */
function lexiconModules(unit: RunUnit, root: string): { modules: string } | { message: string } {
  const reader = unit.reader!;
  const name = lexiconPackageName(reader.lexicon);
  const installed = findInstalledPackage(name, root);
  if (!installed) {
    return {
      message: `kind ${unit.kind} is read by the ${reader.lexicon} lexicon, and ${name} is not installed in a node_modules at or above ${root}; install it there to read this member`,
    };
  }
  if (real(installed) !== real(reader.packageDir)) {
    return {
      message: `kind ${unit.kind} comes from ${reader.packageDir}, and the ${name} found from ${root} is ${real(installed)}; install the pinned package where the workspace resolves it`,
    };
  }
  return { modules: nodeModulesOf(installed, name) };
}

/**
 * Write a reader project for every unit of `plan` that has a `reader`, and
 * point the unit's `abs` at it. Units that can't get one leave the plan and
 * are returned in `failed`. `root` is the directory the plan was made from,
 * the exported tree for `--at`.
 */
export function prepareKindReaders(plan: MemberPlan, root: string): PreparedReaders {
  const failed: SkippedEntry[] = [];
  let scratch: string | undefined;
  const cleanup = () => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  };
  try {
    for (const group of plan.groups) {
      group.units = group.units.filter((unit) => {
        if (!unit.reader) return true;
        const found = lexiconModules(unit, root);
        if ("message" in found) {
          failed.push({ name: unit.member, dir: unit.dir, kind: unit.kind, reason: { code: "command-failed", message: found.message } });
          return false;
        }
        scratch ??= mkdtempSync(join(tmpdir(), "chant-ws-reader-"));
        const project = join(scratch, unit.id);
        mkdirSync(project, { recursive: true });
        const config = substituteGraphConfig(unit.reader.config, { member: unit.member, dir: unit.abs, workspace: root });
        writeFileSync(join(project, "chant.config.json"), `${JSON.stringify({ lexicons: [unit.reader.lexicon], [unit.reader.lexicon]: config }, null, 2)}\n`);
        symlinkSync(found.modules, join(project, "node_modules"), "dir");
        unit.abs = project;
        return true;
      });
    }
    plan.groups = plan.groups.filter((g) => g.units.length > 0);
  } catch (err) {
    cleanup();
    throw err;
  }
  plan.unreadable.push(...failed);
  return { failed, cleanup };
}
