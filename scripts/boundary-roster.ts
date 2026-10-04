/**
 * The owner roster for the workspace boundary (#2657, ws-052; #3161, ws-086).
 *
 * `docs/data/boundary.yaml` names, for each workspace concept, who owns it
 * (chant, hud, studio, behold or a pinned plugin) and what carries it. This module reads and checks
 * the file's shape and renders it into the reference page. Whether the rows
 * match the code is `test/boundary-roster.test.ts`'s job; the page is
 * written by `scripts/generate-boundary-doc.ts`, and the same test fails when
 * the committed page differs from what {@link renderBoundaryPage} returns.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export const OWNERS = ["chant", "hud", "studio", "behold", "plugin"] as const;
export type Owner = (typeof OWNERS)[number];

/** The repository that carries each owner's rows outside chant (ws-086): a row owned by one of these names it as its carrier. */
export const OWNER_REPOS: Partial<Record<Owner, string>> = { hud: "alecraso/hud", studio: "arugula-salad/studio", behold: "INTENTIUS/behold" };

/** The categories, in page order, with the label the page uses and where the code keeps each closed list. */
export const CATEGORIES = {
  area: { label: "boundary cell", source: "the table of #2657, one row per cell" },
  command: { label: "workspace command", source: "`commandRegistry` in `cli/main.ts`, and each sub-verb its help names" },
  "member-kind": { label: "member kind", source: "`BUILTIN_KIND_NAMES` in `kinds.ts`" },
  "record-kind": { label: "record kind", source: "none in core; the reference workspace's and this repository's kind files, or a kind a workspace pins from a third party" },
  "member-link-kind": { label: "member link kind", source: "`LINK_KINDS` in `links.ts`" },
  "record-link-kind": { label: "record link kind", source: "`RECORD_LINK_KINDS` in `record-assets.ts`" },
  "intent-node-kind": { label: "intent node kind", source: "the node kinds of `intent.schema.json`" },
  "intent-edge-kind": { label: "intent edge kind", source: "the edge kinds of `intent.schema.json`" },
  "reason-code": { label: "reason code", source: "`REASONS` in `reason-codes.ts`, less the finding codes" },
  "finding-code": { label: "finding code", source: "the finding codes of `intent.schema.json`" },
  "wsp-check": { label: "WSP check", source: "`WORKSPACE_CHECKS` in `checks.ts` and `checks/*.ts`" },
  "hud-view": { label: "hud view", source: "the hud reader requirements H1 to H11 of #2650" },
} as const;
export type Category = keyof typeof CATEGORIES;

export interface RosterRow {
  category: Category;
  concept: string;
  owner: Owner;
  carrier: string;
  what: string;
  /** A WSP check's name. */
  name?: string;
  /** What a hud view reads. */
  reads?: string;
}

export const ROSTER_PATH = "docs/data/boundary.yaml";
export const BOUNDARY_PAGE = "docs/src/content/docs/reference/boundary.mdx";

const REQUIRED = ["category", "concept", "owner", "carrier", "what"] as const;
const OPTIONAL = new Set(["name", "reads"]);

/** Parse the roster text, returning the rows and every shape problem found. */
export function parseRoster(text: string): { rows: RosterRow[]; problems: string[] } {
  const problems: string[] = [];
  const doc = yaml.load(text) as { rows?: unknown } | null;
  const raw = doc && Array.isArray(doc.rows) ? doc.rows : null;
  if (!raw) return { rows: [], problems: ["the roster has no rows list"] };
  const rows: RosterRow[] = [];
  const seen = new Set<string>();
  raw.forEach((r: unknown, i: number) => {
    const at = `rows[${i}]`;
    if (r === null || typeof r !== "object") {
      problems.push(`${at} is not a mapping`);
      return;
    }
    const row = r as Record<string, unknown>;
    for (const k of REQUIRED) if (typeof row[k] !== "string" || (row[k] as string).trim() === "") problems.push(`${at} has no ${k}`);
    for (const k of Object.keys(row)) if (!(REQUIRED as readonly string[]).includes(k) && !OPTIONAL.has(k)) problems.push(`${at} has unknown field ${k}`);
    if (typeof row.category === "string" && !(row.category in CATEGORIES)) problems.push(`${at} has unknown category ${row.category}`);
    if (typeof row.owner === "string" && !(OWNERS as readonly string[]).includes(row.owner)) problems.push(`${at} has owner ${row.owner}, not one of ${OWNERS.join(", ")}`);
    const key = `${String(row.category)}\0${String(row.concept)}`;
    if (seen.has(key)) problems.push(`${at} repeats ${String(row.category)} ${String(row.concept)}`);
    seen.add(key);
    rows.push(row as unknown as RosterRow);
  });
  return { rows, problems };
}

export function readRoster(repoRoot: string): { rows: RosterRow[]; problems: string[] } {
  return parseRoster(readFileSync(join(repoRoot, ROSTER_PATH), "utf-8"));
}

/** A table cell: pipes and newlines cannot appear, and an angle bracket outside code is a tag to MDX, so it is escaped. */
const cell = (s: string) =>
  s
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .replace(/(`[^`]*`)|[<>]/g, (m, code) => (code ? code : m === "<" ? "&lt;" : "&gt;"));
const code = (s: string) => "`" + s + "`";

/** The boundary table of #2657: the area rows set side by side, one column per owner, in roster order. */
function boundaryTable(rows: RosterRow[]): string[] {
  const cols = OWNERS.map((o) => rows.filter((r) => r.category === "area" && r.owner === o));
  const height = Math.max(...cols.map((c) => c.length));
  const out = [`| ${OWNERS.join(" | ")} |`, `|${OWNERS.map(() => "---|").join("")}`];
  for (let i = 0; i < height; i++) out.push(`| ${cols.map((c) => (c[i] ? cell(c[i].concept) : "")).join(" | ")} |`);
  return out;
}

/** A row's concept as the roster table shows it: code-styled unless it is a cell of the boundary table or a hud view id. */
function conceptCell(r: RosterRow): string {
  if (r.category === "area" || r.category === "hud-view") return cell(r.concept);
  return r.name ? `${code(r.concept)} ${code(r.name)}` : code(r.concept);
}

/** A row's sentence, with what a hud view reads appended. */
function whatCell(r: RosterRow): string {
  return cell(r.reads ? `${r.what} It reads ${r.reads}.` : r.what);
}

/** The whole reference page, rendered from the roster rows. */
export function renderBoundaryPage(rows: RosterRow[]): string {
  const categories = Object.keys(CATEGORIES) as Category[];
  const count = (c: Category, o: Owner) => rows.filter((r) => r.category === c && r.owner === o).length;
  const lines: string[] = [
    "---",
    "title: Owners of the Workspace Boundary",
    "description: The owner of each workspace concept, and the schema or command that carries it.",
    "diataxis: reference",
    "---",
    "",
    "{/* Generated from docs/data/boundary.yaml by scripts/generate-boundary-doc.ts, so edit the roster and run the script. */}",
    "",
    "chant provides the repository specification, which now takes in the domain record kinds and the factory's rules, and nothing that faces a person. hud renders what chant reads and acts on it for the person in front of it, and behold reads a workspace the same way for the infra plane. studio orchestrates and hosts, which covers running builders with their prompts and publishing a box's work. A plugin owns only the record kinds a workspace pins from a third party, with their joins. The decision is [ws-086](https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-086-the-workspace-boundary-without-chud-chant-hud-st.md) ([#3161](https://github.com/INTENTIUS/chant/issues/3161)), which supersedes [ws-052](https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-052-chant-hud-boundary.md) ([#2657](https://github.com/INTENTIUS/chant/issues/2657)).",
    "",
    "## The boundary",
    "",
    ...boundaryTable(rows),
    "",
    "## Rules",
    "",
    "- chant never listens on a port, never authenticates a person and never renders. `test/no-listener.test.ts` holds `packages/core` to the first and to importing no UI or agent-runtime package.",
    "- hud never parses a record file, never runs git for provenance and never computes drift. It reads only through the [read contract](/chant/reference/workspace-read-contract/) and writes only through chant commands. The suite a reader runs to show it ships in `@intentius/chant` as `@intentius/chant/workspace/conformance`, for any test runner.",
    "- The repo is the database ([ws-074](https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-074-the-repo-is-the-database.md), [#3158](https://github.com/INTENTIUS/chant/issues/3158)). Every durable fact about a workspace, anything a person or agent decided, answered, reviewed, approved, wrote or was attributed with and any configuration of a box or member, is a file in the repo. A tool writes it only through chant's write commands. Outside the repo a tool keeps only secrets in a broker or vault, telemetry, caches and indexes it can rebuild from the repo, and the substrate's own runtime state.",
    "- studio defines no record field and keeps no fact outside the repo (ws-074). Its CI runs the reader and writer conformance suites, the same proof asked of hud ([#3159](https://github.com/INTENTIUS/chant/issues/3159), arugula-salad/studio#338). behold is held to hud's rules.",
    "- chant reads a pinned kind's `commitJoins`, and the intent graph reports what they join as `unit`, `contract` and `evidence` nodes. chant's own kinds need no join, because the commit trailers tie a commit to them ([ws-075](https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-075-commit-trailers.md)).",
    "",
    "## The roster",
    "",
    "This page is generated from `docs/data/boundary.yaml`, which has one row for each concept. `test/boundary-roster.test.ts` compares the roster with the closed lists in the code. It fails the build when something in one of those lists has no row, or when a row names something that is not there. A row for a cell of the table above uses the cell's text as #2657 or #3161 words it. Each hud, studio or behold row names its owner's repository as the carrier: alecraso/hud, arugula-salad/studio or INTENTIUS/behold.",
    "",
    `| Category | Where the code keeps it | ${OWNERS.join(" | ")} |`,
    `|---|---|${OWNERS.map(() => "---|").join("")}`,
  ];
  for (const c of categories) lines.push(`| ${CATEGORIES[c].label} | ${CATEGORIES[c].source} | ${OWNERS.map((o) => count(c, o)).join(" | ")} |`);
  lines.push("", "Each row follows, in the order of the table above.", "", "| Category | Concept | Owner | Carried by | What |", "|---|---|---|---|---|");
  for (const c of categories) {
    for (const r of rows.filter((x) => x.category === c)) {
      lines.push(`| ${CATEGORIES[c].label} | ${conceptCell(r)} | ${r.owner} | ${cell(r.carrier)} | ${whatCell(r)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
