#!/usr/bin/env node
// Check that every core docs page carries a Diátaxis quadrant in its
// frontmatter and sits in the matching sidebar group. chant #1731 / #1732.
//
// This is also the main site's reachability gate (chant #1417). Starlight has
// no page auto-discovery, so a page with no sidebar entry can only be reached
// by typing its URL; "in no sidebar group" below is that failure, the same one
// `chant dev check-lexicon` catches for every lexicon site.
//
//   node scripts/check-docs-diataxis.mjs   # exit 1 on any violation
//
// No dependencies. The sidebar is read by slicing the `sidebar: [...]`
// literal out of docs/astro.config.mjs and evaluating it — it is plain data
// (labels, slugs, links, items, badges), so this needs no Astro install.
//
// Lexicons (chant #3993). The literal's one call, `lexiconGroups()`, returns
// the lexicon groups the docs pipeline generated: each lexicon's pages under
// src/content/docs/lexicons/<name>/ and a _sidebar.json fragment beside them.
// This script evaluates the literal with the same function, imported from
// docs/src/lexicon-sidebar.mjs, so it checks the sidebar the site is built
// with. A page in the "Lexicons" group must carry the quadrant of the
// Diátaxis subgroup it sits in (Lexicons > AWS CloudFormation > How-to guides
// means how-to); the lexicon's overview is exempt like the site's index, and
// a page the fragment lists as hidden needs no sidebar entry. Lexicon pages
// exist only after scripts/build-docs.sh has generated them; until then the
// check covers the core pages and says so. `--require-lexicons` makes a
// missing lexicon section a failure (docs-check.yml runs it after the build).
//
// CHANT_DOCS_DIR points the check at another docs site (tests use a fixture).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lexiconFragments } from "../docs/src/lexicon-sidebar.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DOCS = process.env.CHANT_DOCS_DIR ?? join(ROOT, "docs");
const CONTENT = join(DOCS, "src", "content", "docs");
const CONFIG = join(DOCS, "astro.config.mjs");
const LEXICON_DIR = join(CONTENT, "lexicons");
const LEXICONS_GROUP = "Lexicons";
const REQUIRE_LEXICONS = process.argv.includes("--require-lexicons");
const fragments = lexiconFragments(LEXICON_DIR);

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
  const lexiconGroups = () => fragments.map((f) => f.group);
  return new Function("lexiconGroups", `return (${literal});`)(lexiconGroups);
}

/** slug -> the labels of the groups it sits in, outermost first */
function slugGroups(items) {
  const map = new Map();
  const visit = (list, path) => {
    for (const it of list) {
      if (typeof it.slug === "string") {
        if (map.has(it.slug)) violations.push(`${it.slug}: listed twice in the sidebar`);
        map.set(it.slug, path);
      }
      if (Array.isArray(it.items)) visit(it.items, [...path, it.label]);
    }
  };
  for (const top of items) {
    if (typeof top.slug === "string") map.set(top.slug, [top.label]);
    if (Array.isArray(top.items)) visit(top.items, [top.label]);
  }
  return map;
}

/** The lexicon a slug belongs to (`lexicons/<name>/...`), when it has a generated section. */
function lexiconOf(slug) {
  const m = slug.match(/^lexicons\/([^/]+)(\/|$)/);
  return m && existsSync(join(LEXICON_DIR, m[1])) && statSync(join(LEXICON_DIR, m[1])).isDirectory() ? m[1] : undefined;
}

const violations = [];
const groups = slugGroups(sidebar());
const counts = Object.fromEntries(QUADRANTS.map((q) => [q, 0]));
const lexiconCounts = Object.fromEntries(QUADRANTS.map((q) => [q, 0]));
const hidden = new Set(fragments.flatMap((f) => f.hidden));
const withFragment = new Set(fragments.map((f) => f.name));
let unclassified = 0;

/** A page of a lexicon's generated section, checked against its lexicon group. */
function checkLexiconPage(slug, lexicon, q, path) {
  if (!withFragment.has(lexicon)) {
    violations.push(`${slug}: lexicons/${lexicon}/ has no _sidebar.json (regenerate the lexicon's docs)`);
    return;
  }
  const index = slug === `lexicons/${lexicon}`;
  if (index) {
    if (path && path[0] !== LEXICONS_GROUP) violations.push(`${slug}: a lexicon overview in sidebar group "${path[0]}", not "${LEXICONS_GROUP}"`);
    return;
  }
  if (!q) {
    unclassified++;
    violations.push(`${slug}: no diataxis field`);
  } else if (!QUADRANTS.includes(q)) {
    violations.push(`${slug}: diataxis "${q}" is not one of ${QUADRANTS.join(", ")}`);
  } else {
    lexiconCounts[q]++;
  }
  if (!path) {
    if (!hidden.has(slug)) violations.push(`${slug}: in no sidebar group (unreachable, #1417)`);
    return;
  }
  if (path[0] !== LEXICONS_GROUP) {
    violations.push(`${slug}: a lexicon page in sidebar group "${path[0]}", not "${LEXICONS_GROUP}"`);
    return;
  }
  const quadrant = GROUP_TO_QUADRANT[path[2]];
  if (!quadrant) violations.push(`${slug}: lexicon subgroup "${path[2] ?? "(none)"}" is not a Diátaxis group`);
  else if (q && quadrant !== q) violations.push(`${slug}: diataxis "${q}" but lexicon subgroup "${path[2]}"`);
}

for (const file of walk(CONTENT)) {
  const slug = relative(CONTENT, file).replace(/\.mdx?$/, "").replace(/\/index$/, "");
  const fm = frontmatter(readFileSync(file, "utf-8"));
  const q = fm.diataxis;
  const path = groups.get(slug);
  const group = path?.[0];

  const lexicon = lexiconOf(slug);
  if (lexicon) {
    checkLexiconPage(slug, lexicon, q, path);
    continue;
  }

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
    violations.push(`${slug}: in no sidebar group (unreachable, #1417)`);
  } else if (q && GROUP_TO_QUADRANT[group] && GROUP_TO_QUADRANT[group] !== q) {
    violations.push(`${slug}: diataxis "${q}" but sidebar group "${group}"`);
  } else if (q && !GROUP_TO_QUADRANT[group]) {
    violations.push(`${slug}: sidebar group "${group}" is not a Diátaxis group`);
  }
}

if (REQUIRE_LEXICONS && fragments.length === 0) {
  violations.push(`no lexicon sections under ${relative(ROOT, LEXICON_DIR)}/ (run scripts/build-docs.sh first)`);
}

for (const slug of groups.keys()) {
  // A lexicon's overview is its section's index.mdx.
  const candidates = [`${slug}.mdx`, `${slug}.md`, `${slug}/index.mdx`, `${slug}/index.md`];
  if (!candidates.some((c) => existsSync(join(CONTENT, c)))) violations.push(`${slug}: sidebar entry has no page`);
}

console.log(
  `docs: ${QUADRANTS.map((q) => `${counts[q]} ${q}`).join(", ")}` +
    (unclassified ? `, ${unclassified} unclassified` : ""),
);
console.log(
  fragments.length
    ? `lexicons: ${fragments.length} sections, ${QUADRANTS.map((q) => `${lexiconCounts[q]} ${q}`).join(", ")}`
    : "lexicons: no generated sections, so only core pages were checked (scripts/build-docs.sh generates them)",
);
for (const v of violations.sort()) console.log(`  ${v}`);
if (violations.length) {
  console.log(`${violations.length} violation(s)`);
  process.exit(1);
}
