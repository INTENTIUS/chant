/**
 * The upgrade note a breaking lexicon upgrade ships with (#5550).
 *
 * A spec upgrade that removes or renames a name, or changes one in a way that
 * breaks a consumer, changes what a user's imports resolve to. The upgrade
 * pull request body lists those names, but it is not shipped. This writes
 * them to an authored docs page of the lexicon,
 * `lexicons/<lexicon>/docs/pages/upgrade-notes.mdx`, which the docs pipeline
 * publishes under the lexicon's Reference group like every other page there.
 * Each upgrade appends one section headed by the package version it ships as;
 * an upgrade that only adds names writes nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isBreakingChange, type EntryChanges, type SurfaceDelta } from "../../codegen/surface-snapshot";

/** The page's file name under the lexicon's `docs/pages/`. */
export const UPGRADE_NOTE_FILE = "upgrade-notes.mdx";

/** Where a lexicon's upgrade note lives. */
export function upgradeNotePath(lexiconDir: string): string {
  return join(lexiconDir, "docs", "pages", UPGRADE_NOTE_FILE);
}

const code = (s: string) => `\`${s}\``;
const codeList = (names: string[]) => names.map(code).join(", ");

/** What a changed entry lost, in words, or null when nothing it lost breaks a consumer. */
export function describeBreakingChange(c: EntryChanges): string | null {
  if (!isBreakingChange(c)) return null;
  const parts: string[] = [];
  if (c.removedAttrs?.length) parts.push(`attributes dropped: ${codeList(c.removedAttrs)}`);
  if (c.removedProps?.length) parts.push(`properties dropped: ${codeList(c.removedProps)}`);
  if (c.nowRequired?.length) parts.push(`properties now required: ${codeList(c.nowRequired)}`);
  if (c.kindChanged) parts.push(`now a ${c.kindChanged.after}, was a ${c.kindChanged.before}`);
  if (c.resourceTypeChanged) {
    parts.push(`resource type is now ${code(c.resourceTypeChanged.after)}, was ${code(c.resourceTypeChanged.before)}`);
  }
  if (c.createOnlyChanged) {
    const list = (names: string[]) => (names.length ? codeList(names) : "none");
    parts.push(`create-only properties are now ${list(c.createOnlyChanged.after)}, were ${list(c.createOnlyChanged.before)}`);
  }
  if (c.taggableChanged && c.taggableChanged.before === true && c.taggableChanged.after !== true) {
    parts.push("no longer taggable");
  }
  return parts.join("; ");
}

export interface UpgradeNoteOptions {
  lexicon: string;
  delta: SurfaceDelta;
  /** The package version the upgrade ships as, when known. */
  version?: string | null;
  from?: string;
  to?: string | null;
  /** The day of the upgrade, `YYYY-MM-DD`. */
  date: string;
}

/**
 * One upgrade's section of the note, or null when the delta removes,
 * renames and breaks nothing (an additions-only upgrade).
 */
export function upgradeNoteSection(opts: UpgradeNoteOptions): string | null {
  const { delta, version, from, to, date } = opts;
  const changed: Array<{ name: string; what: string }> = [];
  for (const c of delta.changed) {
    const what = describeBreakingChange(c);
    if (what) changed.push({ name: c.name, what });
  }
  // A renamed entry whose shape also broke is listed under its new name.
  for (const r of delta.renamed) {
    const what = r.changes ? describeBreakingChange(r.changes) : null;
    if (what) changed.push({ name: r.to, what });
  }
  if (delta.removed.length === 0 && delta.renamed.length === 0 && changed.length === 0) return null;

  const spec = from && to ? `spec ${from} to ${to}` : "latest spec";
  const lines: string[] = [version ? `## ${version} (${spec})` : `## ${spec[0]!.toUpperCase()}${spec.slice(1)}`, "", `Upgraded on ${date}.`];

  if (delta.renamed.length > 0) {
    lines.push(
      "",
      "### Renamed",
      "",
      "Import the new name in place of the old one. Each stands for the same resource type as before.",
      "",
      "| Old name | New name | Resource type |",
      "|---|---|---|",
      ...delta.renamed.map((r) => `| ${code(r.from)} | ${code(r.to)} | ${code(r.entry.resourceType)} |`),
    );
  }
  if (delta.removed.length > 0) {
    lines.push(
      "",
      "### Removed",
      "",
      "These names are gone from the lexicon and nothing replaces them. Code that imports one no longer builds until the import is taken out.",
      "",
      "| Name | Resource type |",
      "|---|---|",
      ...delta.removed.map((e) => `| ${code(e.name)} | ${code(e.entry.resourceType)} |`),
    );
  }
  if (changed.length > 0) {
    lines.push(
      "",
      "### Changed",
      "",
      "These names still exist with the changes listed. Code that sets a dropped property or reads a dropped attribute no longer builds.",
      "",
      "| Name | Change |",
      "|---|---|",
      ...changed.map((c) => `| ${code(c.name)} | ${c.what} |`),
    );
  }
  return lines.join("\n");
}

/** The page's front matter and opening paragraph, for a lexicon with no note yet. */
export function upgradeNoteHeader(lexicon: string): string {
  return [
    "---",
    `title: "Upgrade notes"`,
    `description: ${JSON.stringify(`Names each upgrade of the ${lexicon} lexicon removed, renamed or changed, and what to use after it`)}`,
    "diataxis: reference",
    "---",
    "",
    `Each section is one upgrade of the ${lexicon} lexicon that removed, renamed or changed a name you may import, headed by the package version it shipped in. The newest is last. An upgrade that only added names has no section.`,
    "",
  ].join("\n");
}

/**
 * Write this upgrade's section into the lexicon's note and return the file's
 * path, or return null and write nothing for an additions-only delta. A note
 * already there keeps its sections and gets this one appended; a section with
 * the same heading (the same upgrade written again) is replaced in place.
 */
export function writeUpgradeNote(lexiconDir: string, opts: UpgradeNoteOptions): string | null {
  const section = upgradeNoteSection(opts);
  if (!section) return null;
  const path = upgradeNotePath(lexiconDir);
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : upgradeNoteHeader(opts.lexicon);
  const heading = section.slice(0, section.indexOf("\n"));

  let next: string;
  const at = existing.indexOf(`\n${heading}\n`);
  if (at >= 0) {
    const end = existing.indexOf("\n## ", at + 1);
    next = existing.slice(0, at + 1) + section + (end >= 0 ? "\n" + existing.slice(end) : "");
  } else {
    next = existing.replace(/\n*$/, "\n\n") + section;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next.replace(/\n*$/, "\n"), "utf-8");
  return path;
}
