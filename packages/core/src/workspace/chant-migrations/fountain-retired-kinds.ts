/**
 * `fountain-retired-kinds` (#3987, managoat/managoat#2793): take a project's
 * fountain declarations off the kinds Managoat v0.29.0 removed.
 *
 * Managoat dropped the team, its schedules, webhooks and persistent
 * sandboxes. Since #3987 the fountain lexicon keeps `Teammate`, `Schedule`
 * and `Webhook` only as stubs, and FTN025 fails a build that declares one, or
 * an Agent with `sandbox_mode: "persistent"`. chud's template (and the studio
 * kit's copy of it) declares a Teammate and a Schedule for its night shift
 * and its factory, and gives the dispatcher a persistent sandbox, so a repo
 * migrated off chud stopped building with chant 0.124.32.
 *
 * In each `chant` member, every `.ts` file that imports the fountain lexicon
 * loses its `new Teammate(...)`, `new Schedule(...)` and `new Webhook(...)`
 * declarations, those names from the import, any one-line constant only they
 * used, and `sandbox_mode: "persistent"`. Each removed Schedule is listed as
 * not moved: its clock now lives outside Managoat. A removed declaration whose
 * name the file still uses elsewhere is a conflict, as is a file that still
 * names a retired kind after the edits.
 *
 * The plan is empty once no fountain file declares a retired kind.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import type { ChantMigration, ChantMigrationContext, ChantMigrationPlan, NotMoved, PlanConflict, PlannedChange } from "../chant-migrations";
import { applyEdits, readText, type Edit } from "./chud-lexicon-exit";

export const FOUNTAIN_RETIRED_KINDS = "fountain-retired-kinds";

const DESCRIPTION = "drop the fountain kinds Managoat removed: Teammate, Schedule, Webhook and persistent sandboxes (#3987)";

const FOUNTAIN = "@intentius/chant-lexicon-fountain";
const RETIRED = ["Teammate", "Schedule", "Webhook"] as const;

const IMPORT = /import\s*\{([^}]*)\}\s*from\s*"@intentius\/chant-lexicon-fountain";/;
/** A top-level declaration of a retired kind, with the doc comment just above it. */
const DECLARATION = /(?:\/\*\*(?:(?!\*\/)[\s\S])*\*\/\n)?export const (\w+) = new (Teammate|Schedule|Webhook)\(\{\n[\s\S]*?\n\}\);\n(?:\n)?/g;
const PERSISTENT = /^[ \t]*sandbox_mode:\s*"persistent",?[ \t]*\n/gm;

/** The template's prose about what the edits remove. */
const TEMPLATE_PROSE: Edit[] = [
  {
    find: " * build by this name (CHUD_FOUNTAIN_VAULT overrides it), and the two\n * Teammates below run with it.\n",
    replace: " * build by this name (CHUD_FOUNTAIN_VAULT overrides it).\n",
  },
  {
    find:
      " * Steward does: a persistent sandbox (its checkout survives a turn) and no\n" +
      " * permission prompts (nobody is at the keyboard; chant's own gates still need\n" +
      " * a person). Its Teammate gives it one thread, so two schedule fires never\n" +
      " * run two dispatchers on one checkout, and the Schedule is what triggers it.\n",
    replace:
      " * Steward does, with no permission prompts (nobody is at the keyboard;\n" +
      " * chant's own gates still need a person). Managoat has no team or scheduler\n" +
      " * any more: a clock outside it runs `chant run dispatch --on fountain`.\n",
  },
];

/** The README row `chud-lexicon-exit` wrote, which names the factory's Schedule. */
const README_EDITS: Edit[] = [
  { find: " (the agents that build the app, as fountain specs; its factory Schedule still calls the kit's dispatch Op)", replace: " (the agents that build the app, as fountain specs)" },
];

function tsFiles(dir: string, rel = "", out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = rel ? posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      tsFiles(dir, path, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** The text with its comments and string contents blanked, so prose naming a kind is not a use of it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');
const uses = (text: string, name: string) => new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(code(text));

interface Rewrite {
  text: string;
  notMoved: NotMoved[];
  conflict?: string;
}

/** The file without its retired declarations, or null when it has none. */
export function rewriteFountainFile(path: string, original: string): Rewrite | null {
  const imported = original.match(IMPORT);
  if (!imported) return null;
  const declared = [...original.matchAll(DECLARATION)];
  const persistent = PERSISTENT.test(original);
  PERSISTENT.lastIndex = 0;
  if (declared.length === 0 && !persistent) return null;

  const notMoved: NotMoved[] = [];
  let text = original;
  const removed: string[] = [];
  const referenced = new Set<string>();
  for (const [block, name, kind] of declared) {
    text = text.replace(block, "");
    removed.push(name!);
    const body = block.slice(block.indexOf("new "));
    for (const id of body.match(/\b[a-zA-Z_$][\w$]*\b/g) ?? []) referenced.add(id);
    if (kind === "Schedule") {
      const cron = body.match(/cron:\s*"([^"]+)"/)?.[1];
      notMoved.push({
        what: `the Schedule ${name}${cron ? ` (cron "${cron}")` : ""} in ${path}`,
        where: "a clock outside Managoat, which has no scheduler: a CI schedule or a CronJob running `chant run <op> --on fountain`, or `chant operator --steward`",
      });
    } else if (kind === "Webhook") {
      notMoved.push({ what: `the Webhook ${name} in ${path}`, where: "nothing: read a run's outcome from `chant run status` or `log`, or the conversation's event stream" });
    }
  }
  text = text.replace(PERSISTENT, "");

  // A one-line constant only the removed declarations used (the template's `nightlyMeta`).
  for (const id of referenced) {
    const line = new RegExp(`^export const ${id} = [^\\n]*;\\n\\n?`, "m");
    const hit = text.match(line);
    if (hit && !uses(text.replace(hit[0], ""), id)) text = text.replace(hit[0], "");
  }

  const names = imported[1]!.split(",").map((n) => n.trim()).filter(Boolean);
  const kept = names.filter((n) => !(RETIRED as readonly string[]).includes(n) || uses(text.replace(IMPORT, ""), n));
  if (kept.length !== names.length) text = text.replace(IMPORT, `import { ${kept.join(", ")} } from "${FOUNTAIN}";`);
  text = applyEdits(text, TEMPLATE_PROSE).text.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");

  const dangling = removed.filter((n) => uses(text, n));
  if (dangling.length > 0) return { text, notMoved, conflict: `${dangling.join(", ")} ${dangling.length === 1 ? "is" : "are"} still used after the retired declarations go. Remove ${dangling.length === 1 ? "that use" : "those uses"} by hand, then run the upgrade again` };
  const still = RETIRED.filter((k) => new RegExp(`\\bnew ${k}\\(`).test(text));
  if (still.length > 0) return { text, notMoved, conflict: `a ${still.join(", ")} declaration this migration cannot read. Remove it by hand, then run the upgrade again` };
  return { text, notMoved };
}

interface Declaration {
  members?: Array<{ dir?: string; kind?: string }>;
}

function planRetiredKinds(ctx: ChantMigrationContext): ChantMigrationPlan | null {
  const { dir } = ctx;
  let decl: Declaration | null = null;
  try {
    decl = JSON.parse(readText(dir, "chant.workspace.json") ?? "null") as Declaration | null;
  } catch {
    decl = null;
  }
  const members = (decl?.members ?? []).filter((m) => m.kind === "chant" && m.dir).map((m) => posix.normalize(m.dir!));
  if (members.length === 0 && existsSync(join(dir, "chant.config.ts"))) members.push(".");

  const changes: PlannedChange[] = [];
  const notMoved: NotMoved[] = [];
  const conflicts: PlanConflict[] = [];
  for (const member of members) {
    for (const rel of tsFiles(join(dir, member))) {
      const path = posix.join(member, rel);
      const text = readText(dir, path);
      if (text === undefined || !text.includes(FOUNTAIN)) continue;
      const rewrite = rewriteFountainFile(path, text);
      if (!rewrite) continue;
      if (rewrite.conflict) {
        conflicts.push({ path, reason: rewrite.conflict });
        continue;
      }
      changes.push({ path, action: "write", why: "no Teammate, Schedule, Webhook or persistent sandbox, which Managoat removed and FTN025 fails", data: Buffer.from(rewrite.text) });
      notMoved.push(...rewrite.notMoved);
    }
  }
  if (changes.length === 0 && conflicts.length === 0) return null;

  const readme = readText(dir, "README.md");
  if (readme !== undefined && conflicts.length === 0) {
    const edited = applyEdits(readme, README_EDITS).text;
    if (edited !== readme) changes.push({ path: "README.md", action: "write", why: "the agents no longer declare a factory Schedule", data: Buffer.from(edited) });
  }
  return { id: FOUNTAIN_RETIRED_KINDS, description: DESCRIPTION, changes, notMoved, conflicts };
}

export const fountainRetiredKinds: ChantMigration = {
  id: FOUNTAIN_RETIRED_KINDS,
  description: DESCRIPTION,
  plan: planRetiredKinds,
};
