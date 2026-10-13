/**
 * Re-pinning records after template parameters are substituted (#2549, #2627).
 *
 * A template's decision records may pin a file of the template by hash. When
 * `chant init --from` or `chant workspace upgrade` fills that file's
 * `{{chant:<name>}}` placeholders, the copy's bytes differ from the
 * template's, and every copy would report the pin as drifted on day one. So
 * after substitution, each pin that held in the template and names a
 * substituted file gets the hash of the substituted content.
 *
 * A record is any Markdown file whose front matter has an `evidence` list
 * with path pins. Its paths resolve from the nearest directory above it that
 * holds a workspace declaration, as `chant workspace records` resolves them.
 * A pin that did not hold in the template stays as it is: re-pinning follows
 * the substitution and never hides drift the template already had. Only the
 * `sha256` value on the pin's line changes; the rest of the file is kept byte
 * for byte.
 */

import { sha256Hex } from "../content-digest";
import { pinEntries } from "./record-assets";
import { parseFrontMatter } from "./records";

const DECLARATIONS = ["chant.workspace.json", "chant.workspace.jsonc"];
const EVIDENCE = "evidence";

/** A record whose pins were rewritten: its path in the template, and the pinned paths, from its workspace root. */
export interface RepinnedRecord {
  record: string;
  paths: string[];
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The nearest directory at or above `dir` holding a workspace declaration in `files`, or "" for the root. */
function workspaceRootOf(files: ReadonlyMap<string, Buffer>, dir: string): string {
  for (let d = dir; ; d = dirOf(d)) {
    if (DECLARATIONS.some((name) => files.has(d === "" ? name : `${d}/${name}`))) return d;
    if (d === "") return "";
  }
}

/**
 * Rewrite, in `substituted`, the pins of every record that name a file in
 * `changed` and held against `original`. Returns the files with the records
 * rewritten, and which records were.
 */
export function repinSubstituted(
  original: ReadonlyMap<string, Buffer>,
  substituted: ReadonlyMap<string, Buffer>,
  changed: readonly string[],
): { files: Map<string, Buffer>; repinned: RepinnedRecord[] } {
  const files = new Map(substituted);
  const repinned: RepinnedRecord[] = [];
  if (changed.length === 0) return { files, repinned };
  const changedSet = new Set(changed);
  for (const [recordPath, data] of [...substituted].sort(([a], [b]) => a.localeCompare(b))) {
    if (!recordPath.endsWith(".md")) continue;
    const text = data.toString("utf-8");
    const fm = parseFrontMatter(text);
    if (!fm.ok) continue;
    const root = workspaceRootOf(substituted, dirOf(recordPath));
    const full = (p: string) => (root === "" ? p : `${root}/${p}`);
    const updates = new Map<string, { from: string; to: string }>();
    for (const pin of pinEntries(fm.value, EVIDENCE)) {
      const file = full(pin.path);
      if (!changedSet.has(file)) continue;
      const before = original.get(file);
      const after = substituted.get(file);
      if (!before || !after || sha256Hex(before) !== pin.sha256) continue;
      updates.set(pin.path, { from: pin.sha256, to: sha256Hex(after) });
    }
    if (updates.size === 0) continue;
    const rewritten = rewritePins(text, updates);
    // Only a rewrite that reads back with every update applied is kept.
    const check = parseFrontMatter(rewritten);
    const pins = check.ok ? pinEntries(check.value, EVIDENCE) : [];
    if (![...updates].every(([path, u]) => pins.some((p) => p.path === path && p.sha256 === u.to))) continue;
    files.set(recordPath, Buffer.from(rewritten, "utf-8"));
    repinned.push({ record: recordPath, paths: [...updates.keys()].sort() });
  }
  return { files, repinned };
}

/**
 * Replace the `sha256` of each updated pin in the front matter. A pin is a
 * list entry, from its `- ` line to the next one at the same indentation or
 * less, holding both `path: "<path>"` and `sha256: "<old>"`.
 */
function rewritePins(text: string, updates: ReadonlyMap<string, { from: string; to: string }>): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) return text;
  const starts: number[] = [];
  for (let i = 1; i < end; i++) if (/^\s*- /.test(lines[i])) starts.push(i);
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const indent = lines[from].search(/-/);
    let to = end;
    for (let i = from + 1; i < end; i++) {
      const lead = lines[i].search(/\S/);
      if (lead >= 0 && lead <= indent) {
        to = i;
        break;
      }
    }
    const entry = lines.slice(from, to).join("\n");
    const path = entry.match(/(?:^|\n)\s*(?:- )?path: "([^"]*)"/)?.[1];
    const update = path !== undefined ? updates.get(path) : undefined;
    if (!update) continue;
    for (let i = from; i < to; i++) {
      if (new RegExp(`^(\\s*(?:- )?sha256: )"${update.from}"\\s*$`).test(lines[i])) lines[i] = lines[i].replace(update.from, update.to);
    }
  }
  return lines.join(eol);
}
