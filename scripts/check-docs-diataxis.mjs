#!/usr/bin/env node
// Check that every core docs page carries a Diátaxis quadrant in its
// frontmatter and sits in the matching sidebar group. chant #1731 / #1732.
//
//   node scripts/check-docs-diataxis.mjs   # exit 1 on any violation
//
// No dependencies. The sidebar is read by slicing the `sidebar: [...]`
// literal out of docs/astro.config.mjs and evaluating it — it is plain data
// (labels, slugs, links, items, badges), so this needs no Astro install.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CONTENT = join(ROOT, "docs", "src", "content", "docs");
const CONFIG = join(ROOT, "docs", "astro.config.mjs");

const QUADRANTS = ["tutorial", "how-to", "reference", "explanation"];
const GROUP_TO_QUADRANT = {
  Tutorials: "tutorial",
  "How-to guides": "how-to",
  Reference: "reference",
  Explanation: "explanation",
};
// Pages that live outside the four quadrants by design.
const EXEMPT = new Set(["index", "whats-new"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.mdx?$/.test(name)) out.push(p);
  }
  return out;
}

function frontmatter(text) {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};
  const fm = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

function sidebar() {
  const src = readFileSync(CONFIG, "utf-8");
  const start = src.indexOf("sidebar: [");
  if (start === -1) throw new Error("no `sidebar: [` in docs/astro.config.mjs");
  let i = start + "sidebar: ".length;
  let depth = 0;
  let quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const literal = src.slice(start + "sidebar: ".length, i + 1);
  return new Function(`return (${literal});`)();
}

/** slug -> top-level group label */
function slugGroups(items) {
  const map = new Map();
  for (const top of items) {
    const label = top.label;
    const visit = (list) => {
      for (const it of list) {
        if (typeof it.slug === "string") {
          if (map.has(it.slug)) violations.push(`${it.slug}: listed twice in the sidebar`);
          map.set(it.slug, label);
        }
        if (Array.isArray(it.items)) visit(it.items);
      }
    };
    if (typeof top.slug === "string") map.set(top.slug, label);
    if (Array.isArray(top.items)) visit(top.items);
  }
  return map;
}

const violations = [];
const groups = slugGroups(sidebar());
const counts = Object.fromEntries(QUADRANTS.map((q) => [q, 0]));
let unclassified = 0;

for (const file of walk(CONTENT)) {
  const slug = relative(CONTENT, file).replace(/\.mdx?$/, "").replace(/\/index$/, "");
  const fm = frontmatter(readFileSync(file, "utf-8"));
  const q = fm.diataxis;
  const group = groups.get(slug);

  if (EXEMPT.has(slug)) {
    if (q) violations.push(`${slug}: exempt page should not carry diataxis`);
    continue;
  }
  if (!q) {
    unclassified++;
    violations.push(`${slug}: no diataxis field`);
  } else if (!QUADRANTS.includes(q)) {
    violations.push(`${slug}: diataxis "${q}" is not one of ${QUADRANTS.join(", ")}`);
  } else {
    counts[q]++;
  }
  if (!group) {
    violations.push(`${slug}: in no sidebar group`);
  } else if (q && GROUP_TO_QUADRANT[group] && GROUP_TO_QUADRANT[group] !== q) {
    violations.push(`${slug}: diataxis "${q}" but sidebar group "${group}"`);
  } else if (q && !GROUP_TO_QUADRANT[group]) {
    violations.push(`${slug}: sidebar group "${group}" is not a Diátaxis group`);
  }
}

for (const slug of groups.keys()) {
  try {
    statSync(join(CONTENT, `${slug}.mdx`));
  } catch {
    try {
      statSync(join(CONTENT, `${slug}.md`));
    } catch {
      violations.push(`${slug}: sidebar entry has no page`);
    }
  }
}

console.log(
  `docs: ${QUADRANTS.map((q) => `${counts[q]} ${q}`).join(", ")}` +
    (unclassified ? `, ${unclassified} unclassified` : ""),
);
for (const v of violations.sort()) console.log(`  ${v}`);
if (violations.length) {
  console.log(`${violations.length} violation(s)`);
  process.exit(1);
}
