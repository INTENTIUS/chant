/**
 * `chud-lexicon-exit-ship-inputs` (#2811): the release Op asks the ship-skip
 * point with the inputs the point declares.
 *
 * The release Op `chud-lexicon-exit` (0.92.0) wrote asks `ship-skip` with no
 * inputs, so the point's table can only give its default row. This migration
 * makes the Op compute the point's `release.*` inputs when it loads, from the
 * diff between the commit the `fly` site serves (the last release in its
 * ledger) and HEAD, and pass the ones the point declares to `decide`:
 *
 * - `first_release`: no release in the ledger;
 * - `new_migrations`: `.sql` files added or changed under the app's
 *   migrations folder;
 * - `files_changed`: paths changed;
 * - `app_changed`: a path under the app member;
 * - `work_changed`: a path under the directory a declared work kind keeps its
 *   items in (chud's `contracts_changed`);
 * - `units`: work item files added or changed.
 *
 * A first release, or one whose serving commit this clone lacks, counts every
 * file on HEAD, as chud's release plan did. The inputs are not part of the
 * release plan, which keeps the answer and its decider, so a retry of a
 * shipped commit plans the same digest.
 *
 * The plan is empty unless the member's release Op is the one
 * `chud-lexicon-exit` wrote and still asks `ship-skip` with no inputs. A
 * release Op the project changed so that an anchor is gone is a conflict.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { ChantMigration, ChantMigrationContext, ChantMigrationPlan, PlanConflict, PlannedChange } from "../chant-migrations";
import { CHUD_LEXICON_EXIT } from "./chud-lexicon-exit";

export const CHUD_LEXICON_EXIT_SHIP_INPUTS = "chud-lexicon-exit-ship-inputs";

const DESCRIPTION = "have the release Op ask ship-skip with the inputs the point declares, from the diff since the serving release (#2811)";

/** The call chud-lexicon-exit wrote: no inputs. */
const ASKED_BARE = 'const shipSkip = decide("ship-skip", { id: "shipSkip" });';

/** Where a declared work kind keeps its items, from the workspace root: what `release.work_changed` and `release.units` count. */
export interface WorkItems {
  dir: string;
  /** The kind's `location.match`, a regular expression over a file's name. */
  match: string;
}

interface Declaration {
  members?: Array<{ name?: string; dir?: string; kind?: string; records?: Array<{ kind?: string }> }>;
  records?: Array<{ kind?: string }>;
}

function readText(dir: string, path: string): string | undefined {
  const abs = join(dir, path);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : undefined;
}

/**
 * Where each declared work kind keeps its items, read from the kind file's
 * text: a kind with a `work` block, its `location.dir` and `location.match`.
 */
export function workItemsOf(dir: string, decl: Declaration | null): WorkItems[] {
  const out: WorkItems[] = [];
  const kinds = [...(decl?.records ?? []), ...(decl?.members ?? []).flatMap((m) => (m.records ?? []).map((r) => ({ kind: r.kind && m.dir ? posix.join(m.dir, r.kind) : undefined })))];
  for (const { kind } of kinds) {
    if (!kind) continue;
    const text = readText(dir, kind);
    if (!text || !/\bwork:\s*\{/.test(text)) continue;
    const loc = /location:\s*\{\s*dir:\s*("(?:[^"\\]|\\.)*"),\s*match:\s*("(?:[^"\\]|\\.)*")/.exec(text);
    if (!loc) continue;
    try {
      out.push({ dir: posix.normalize(posix.join(posix.dirname(kind), JSON.parse(loc[1]) as string)), match: JSON.parse(loc[2]) as string });
    } catch {
      continue;
    }
  }
  return out;
}

/** The code that computes the inputs and asks the point with them, in place of {@link ASKED_BARE}. */
export function askedWithInputs(rootRel: string, appDir: string, work: WorkItems[]): string {
  return `/** The workspace root, which the diff names paths from. */
const root = fileURLToPath(new URL(${JSON.stringify(rootRel === "." ? "./" : `${rootRel}/`)}, import.meta.url));
/** The app member and the work items, from the workspace root. */
const APP = ${JSON.stringify(appDir)};
const WORK: Array<{ dir: string; match: string }> = ${JSON.stringify(work)};

/**
 * The ship-skip point's inputs: what this release would change since the
 * commit the site serves, the last release in the ledger. A first release
 * (or one whose serving commit this clone lacks) counts every file on HEAD.
 */
async function shipSkipInputs(): Promise<Record<string, boolean | number>> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf-8" });
  const lines = (text: string) => text.split("\\n").filter(Boolean);
  const { records } = await readReleaseLedger(ENV, { cwd: fileURLToPath(new URL("../", import.meta.url)) });
  const serving = records.at(-1)?.gitSha;
  let known = false;
  if (serving) {
    try {
      git("cat-file", "-e", \`\${serving}^{commit}\`);
      known = true;
    } catch {
      known = false;
    }
  }
  const all = known ? lines(git("diff", "--name-only", "--relative", serving!, "HEAD")) : lines(git("ls-tree", "-r", "--name-only", "HEAD"));
  const added = known ? lines(git("diff", "--name-only", "--relative", "--diff-filter=AM", serving!, "HEAD")) : all;
  const under = (dir: string, path: string) => dir === "." || path.startsWith(\`\${dir}/\`);
  const migrations = posix.join(APP, params.appMigrations.default);
  const workItems = added.filter((p) => WORK.some((w) => posix.dirname(p) === posix.normalize(w.dir) && new RegExp(w.match).test(posix.basename(p))));
  return {
    "release.first_release": !serving,
    "release.new_migrations": added.filter((p) => under(migrations, p) && p.endsWith(".sql")).length,
    "release.files_changed": all.length,
    "release.app_changed": all.some((p) => under(APP, p)),
    "release.work_changed": all.some((p) => WORK.some((w) => under(posix.normalize(w.dir), p))),
    "release.units": workItems.length,
  };
}

/** Only the inputs the point declares: a point that declares fewer is asked with those. */
const declared = new Set(Object.keys(shipSkipPoint.inputs));
const inputs = Object.fromEntries(Object.entries(await shipSkipInputs()).filter(([name]) => declared.has(name)));
const shipSkip = decide("ship-skip", { id: "shipSkip", inputs });`;
}

/** Each edit: the text chud-lexicon-exit wrote, and what it becomes. A \`find\` may be a pattern, for text that differs between the exit's versions. */
function edits(rootRel: string, appDir: string, work: WorkItems[]): Array<{ find: string | RegExp; replace: string; what: string; optional?: boolean }> {
  return [
    { find: ASKED_BARE, replace: askedWithInputs(rootRel, appDir, work), what: "the ship-skip decide step" },
    { find: 'import { readFileSync } from "node:fs";\n', replace: 'import { readFileSync } from "node:fs";\nimport { posix } from "node:path";\n', what: "the node:fs import" },
    {
      find: 'import { parsePoints, quorumOf } from "@intentius/chant/workspace/points";\n',
      replace: 'import { parsePoints, quorumOf } from "@intentius/chant/workspace/points";\nimport { readReleaseLedger } from "@intentius/chant/lifecycle/release-ledger";\n',
      what: "the workspace/points import",
    },
    {
      // 0.92.0 named the systemone lexicon's decide; later exits name chant's.
      find: /( \*   workspace root, through (?:the systemone lexicon's|chant's) `decide` activity), and\n \*   writes the release plan:/,
      replace:
        "$1, with\n *   the inputs it declares, computed from the diff between the commit the\n *   `fly` site serves (the last release in its ledger) and HEAD: whether\n *   this is the first release, how many migrations would fire, how many files\n *   changed, whether the app or the work items changed, and how many work\n *   items did (on a first release, every file on HEAD counts). It\n *   writes the release plan:",
      what: "the release Op's comment on Plan",
      // The comment is prose: a project that reworded it keeps its words.
      optional: true,
    },
  ];
}

function planShipInputs(ctx: ChantMigrationContext): ChantMigrationPlan | null {
  const { dir } = ctx;
  let decl: Declaration | null = null;
  try {
    decl = JSON.parse(readText(dir, "chant.workspace.json") ?? "null") as Declaration | null;
  } catch {
    decl = null;
  }
  const candidates = (decl?.members ?? []).filter((m) => m.kind === "chant" && m.dir).map((m) => posix.normalize(m.dir!));
  if (!candidates.includes("delivery")) candidates.push("delivery");
  const appDir = decl?.members?.find((m) => m.name === "app")?.dir ?? "app";
  const work = workItemsOf(dir, decl);

  const changes: PlannedChange[] = [];
  const conflicts: PlanConflict[] = [];
  for (const d of candidates) {
    const path = posix.join(d, "ops/release.op.ts");
    const text = readText(dir, path);
    if (text === undefined || !text.includes(`its migration ${CHUD_LEXICON_EXIT}`) || !text.includes("flyRelease(")) continue;
    if (!text.includes(ASKED_BARE)) continue;
    let next = text;
    const missing: string[] = [];
    for (const e of edits(posix.relative(posix.join(d, "ops"), ".") || ".", posix.normalize(appDir), work)) {
      const hit = typeof e.find === "string" ? next.includes(e.find) : e.find.test(next);
      if (!hit) {
        if (!e.optional) missing.push(e.what);
        continue;
      }
      next = typeof e.find === "string" ? next.replace(e.find, () => e.replace) : next.replace(e.find, e.replace);
    }
    if (missing.length > 0) {
      conflicts.push({ path, reason: `cannot find ${missing.join("; ")}. Pass ship-skip its inputs by hand, then run the upgrade again` });
      continue;
    }
    changes.push({ path, action: "write", why: "ship-skip is asked with the inputs the point declares, from the diff since the serving release", data: Buffer.from(next) });
  }
  if (changes.length === 0 && conflicts.length === 0) return null;
  return { id: CHUD_LEXICON_EXIT_SHIP_INPUTS, description: DESCRIPTION, changes, notMoved: [], conflicts };
}

export const chudLexiconExitShipInputs: ChantMigration = {
  id: CHUD_LEXICON_EXIT_SHIP_INPUTS,
  description: DESCRIPTION,
  plan: planShipInputs,
};
