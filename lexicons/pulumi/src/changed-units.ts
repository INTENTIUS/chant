/**
 * The Pulumi stacks a change touched, judged from the changed files alone
 * (`LexiconPlugin.changedUnits`, #3183; INTENTIUS/plywood#22). A Pulumi
 * program and its stack configs are not chant source, so `chant lifecycle
 * affected`'s artifact diff never shows them, and without this a pull request
 * that edits `Pulumi.dev.yaml` selects no component at all.
 *
 * A file belongs to the nearest directory at or above it holding a
 * `Pulumi.yaml` (or `Pulumi.yml`), the project, never above the project root:
 *
 *   - `Pulumi.<stack>.yaml` in that directory is the stack's config, so it
 *     touches that stack alone;
 *   - any other file there or below (the program, `Pulumi.yaml`, the
 *     package files) touches every stack of the project, which is each
 *     `Pulumi.<stack>.yaml` beside `Pulumi.yaml` at head and any the change
 *     deleted. A stack with no config file has no file to find it by, so a
 *     program change does not reach it.
 *
 * Files under a directory whose name starts with a dot (`.forgejo`, `.chant`,
 * `.git`) or under `node_modules` are not the program. A file outside every
 * project, such as a module the program imports from `../shared`, is not
 * claimed.
 *
 * Each unit is named as core's `DEPLOY_UNIT_RULES` names a `pulumi-up` step:
 * `<dir>/<stack>`, or `<stack>` for a project at the project root.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

const PROJECT_FILES = ["Pulumi.yaml", "Pulumi.yml"];
const STACK_CONFIG = /^Pulumi\.(.+)\.ya?ml$/;

/** The unit core names for a `pulumi-up` step on `stack` in `dir` (deploy-units.ts `pulumiStackUnit`). */
export function pulumiStackUnit(dir: string, stack: string): string {
  const d = dir.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return d === "" || d === "." ? stack : `${d}/${stack}`;
}

/** The project directory (relative, `""` for the root) holding `file`, or undefined when none does. */
function projectOf(projectRoot: string, file: string, changed: ReadonlySet<string>): string | undefined {
  let dir = posix.dirname(file);
  for (;;) {
    const rel = dir === "." ? "" : dir;
    for (const name of PROJECT_FILES) {
      const p = rel === "" ? name : `${rel}/${name}`;
      // A deleted Pulumi.yaml still names its project for the change that deleted it.
      if (existsSync(join(projectRoot, p)) || changed.has(p)) return rel;
    }
    if (rel === "") return undefined;
    dir = posix.dirname(dir);
  }
}

/** The stacks of the project in `dir`: the stack configs at head, and the ones the change names. */
function stacksOf(projectRoot: string, dir: string, changed: readonly string[]): string[] {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(join(projectRoot, dir));
  } catch {
    // The project directory is gone at head; the change's own files still name stacks.
  }
  for (const n of names) {
    const m = STACK_CONFIG.exec(n);
    if (m) out.add(m[1]!);
  }
  for (const f of changed) {
    if (posix.dirname(f) !== (dir === "" ? "." : dir)) continue;
    const m = STACK_CONFIG.exec(posix.basename(f));
    if (m) out.add(m[1]!);
  }
  return [...out];
}

function ignored(file: string): boolean {
  const parts = file.split("/");
  return parts.slice(0, -1).some((p) => p.startsWith(".") || p === "node_modules");
}

/** The stack units `changedFiles` (relative to `projectRoot`, `/` separators) touch, sorted. */
export function pulumiChangedUnits(projectRoot: string, changedFiles: readonly string[]): string[] {
  const files = changedFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")).filter((f) => f !== "" && !f.startsWith("../") && !ignored(f));
  const changed = new Set(files);
  const units = new Set<string>();
  const whole = new Set<string>();
  for (const f of files) {
    const dir = projectOf(projectRoot, f, changed);
    if (dir === undefined) continue;
    const here = posix.dirname(f) === (dir === "" ? "." : dir);
    const m = STACK_CONFIG.exec(posix.basename(f));
    if (here && m && !PROJECT_FILES.includes(posix.basename(f))) units.add(pulumiStackUnit(dir, m[1]!));
    else whole.add(dir);
  }
  for (const dir of whole) for (const stack of stacksOf(projectRoot, dir, files)) units.add(pulumiStackUnit(dir, stack));
  return [...units].sort();
}
