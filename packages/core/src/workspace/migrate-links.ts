/**
 * The workspace links `chant migrate` writes (#4399).
 *
 * A migration reads one member (the Postgres tables) and writes into another
 * (the ClickHouse mirrors). When both sit in a workspace, the migrated
 * output reads the source member's outputs, and the declaration should say
 * so: `chant workspace check` then fails when the source drops or renames an
 * output until the mirror follows (WSP093, `./checks/links.ts`).
 *
 * {@link planMigrateLinks} finds the declaration above the source, the member
 * that holds the source and the member that holds the output file, and adds
 * a `links` entry on the second for each output the migration names. It
 * changes only the text of that member's `links`, as the other declaration
 * write commands do (`./json-edit.ts`). It returns a plan; the caller writes
 * it. A migration with no workspace around it, or whose source and output
 * are one member, has nothing to link and returns a reason when that is
 * worth telling.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DECLARATION_FILES, parseDeclaration, type Declaration, type Member } from "./declaration";
import { appendElement, setProperty } from "./json-edit";

export interface MigrateLinkPlan {
  /** The declaration file, absolute. */
  file: string;
  /** The producer: the member that holds the source. */
  producer: string;
  /** The consumer: the member that holds the output file. */
  consumer: string;
  /** Outputs the consumer did not link to before. */
  added: string[];
  /** The declaration's new text; equal to the old when nothing was added. */
  text: string;
}

export type MigrateLinkOutcome = { plan: MigrateLinkPlan } | { skipped: string } | undefined;

/** The workspace declaration at or above `start`. */
function findDeclaration(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    for (const name of DECLARATION_FILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The deepest member whose directory holds `path`. */
function memberHolding(declaration: Declaration, root: string, path: string): Member | undefined {
  let best: { member: Member; depth: number } | undefined;
  for (const m of declaration.members) {
    const memberRoot = resolve(root, m.dir);
    const rel = relative(memberRoot, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    // The longer root is the deeper member.
    if (!best || memberRoot.length > best.depth) best = { member: m, depth: memberRoot.length };
  }
  return best?.member;
}

/**
 * Plan the links from the member holding `sourcePath` to the outputs a
 * migration read, on the member holding `outputPath`.
 */
export function planMigrateLinks(opts: { sourcePath: string; outputPath: string | undefined; outputs: readonly string[] }): MigrateLinkOutcome {
  const source = resolve(opts.sourcePath);
  const file = findDeclaration(source);
  if (!file) return undefined;
  if (opts.outputPath === undefined) return { skipped: "pass --output inside the ClickHouse member to link its columns to the Postgres member" };
  const root = dirname(file);
  const text = readFileSync(file, "utf8");
  let declaration: Declaration;
  try {
    declaration = parseDeclaration(text, file);
  } catch (err) {
    return { skipped: `the workspace declaration ${file} does not read, so no link was written: ${err instanceof Error ? err.message : String(err)}` };
  }
  const producer = memberHolding(declaration, root, source);
  const consumer = memberHolding(declaration, root, resolve(opts.outputPath));
  if (!producer) return { skipped: `${opts.sourcePath} is in no member of ${file}, so no link was written` };
  if (!consumer) return { skipped: `${opts.outputPath} is in no member of ${file}, so no link was written` };
  if (producer.name === consumer.name) return { skipped: `the source and the output are both in member ${producer.name}; a member does not link to itself` };

  const have = new Set(consumer.links.filter((l) => l.member === producer.name && l.kind === null).map((l) => l.output));
  const added = [...new Set(opts.outputs)].filter((o) => !have.has(o));
  if (added.length === 0) return { plan: { file, producer: producer.name, consumer: consumer.name, added, text } };

  const jsonc = file.endsWith(".jsonc");
  const links = added.map((output) => ({ member: producer.name, output }));
  let next = text;
  if (consumer.links.length === 0) {
    next = setProperty(next, jsonc, consumer.pointer, "links", links);
  } else {
    for (const l of links) next = appendElement(next, jsonc, `${consumer.pointer}/links`, l);
  }
  // The edit is never written unless it reads back with the links it meant to add.
  const back = parseDeclaration(next, file).members.find((m) => m.name === consumer.name);
  if (!back || back.links.length !== consumer.links.length + added.length) {
    return { skipped: `the edit to ${file} did not read back as the links it meant to add, so nothing was written` };
  }
  return { plan: { file, producer: producer.name, consumer: consumer.name, added, text: next } };
}
