#!/usr/bin/env node
// Turns a decision table in an issue body into draft decision files, and
// checks decision files against their schema. The format is described in
// docs/design/decisions/README.md (#2555, #2557).
//
//   node scripts/import-decisions.mjs --issue INTENTIUS/chant#2524 --prefix ws
//   node scripts/import-decisions.mjs --body body.md --issue INTENTIUS/chant#2524 --prefix ws --dry-run
//   node scripts/import-decisions.mjs --check
//
// Import reads the table under a heading (default "Decisions") with a topic,
// a chosen and a rejected column. Rejected cells split on ";". A "(vN)" after
// a topic records the revision that changed the row; a "(vN)" after a rejected
// option marks the option chosen in that revision, and the draft lists it in
// `supersedes`. Drafts leave the question, the reasons and each option's
// working and trade-off null, so `--check` fails until someone writes them.
// Existing files are never overwritten unless --force is given.
//
// --check needs js-yaml and ajv, which the repo root already installs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(root, "docs", "design", "decisions");

function parseArgs(argv) {
  const opts = { heading: "Decisions", dir: DEFAULT_DIR, state: "decided", start: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--issue") opts.issue = next();
    else if (a === "--body") opts.body = next();
    else if (a === "--prefix") opts.prefix = next();
    else if (a === "--heading") opts.heading = next();
    else if (a === "--dir") opts.dir = next();
    else if (a === "--state") opts.state = next();
    else if (a === "--start") opts.start = Number(next());
    else if (a === "--decided-by") opts.decidedBy = next();
    else if (a === "--decided-on") opts.decidedOn = next();
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

const USAGE = `usage:
  import-decisions.mjs --issue <owner/repo#n> --prefix <id prefix> [--body <file>]
                       [--heading Decisions] [--dir <out>] [--state decided]
                       [--start 1] [--decided-by <login>] [--decided-on YYYY-MM-DD]
                       [--dry-run] [--force]
  import-decisions.mjs --check [--dir <dir>]`;

// ── Reading the table ──────────────────────────────────────────────────────

/** Split one Markdown table row into trimmed cells, keeping escaped pipes and
 * pipes inside backticks. */
export function splitRow(line) {
  const cells = [];
  let cell = "";
  let inCode = false;
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cell += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const isDivider = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const isRow = (line) => line.trim().startsWith("|");

/** The rows of the decision table under `heading`. A blank line between rows
 * of the same table is tolerated, since issue editors insert them. */
export function readTable(markdown, heading) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${escape(heading)}\\s*$`, "i").test(l));
  if (start < 0) throw new Error(`no heading "${heading}" in the issue body`);
  let i = start + 1;
  while (i < lines.length && !isRow(lines[i])) {
    if (/^#{1,6}\s/.test(lines[i])) throw new Error(`no table under "${heading}"`);
    i++;
  }
  if (i >= lines.length || !isDivider(lines[i + 1] ?? "")) throw new Error(`no table under "${heading}"`);
  const header = splitRow(lines[i]).map((h) => h.toLowerCase());
  const col = (names) => {
    const idx = header.findIndex((h) => names.includes(h));
    if (idx < 0) throw new Error(`table has no ${names.join("/")} column (columns: ${header.join(", ")})`);
    return idx;
  };
  const cols = {
    topic: col(["topic", "question", "decision"]),
    chosen: col(["chosen", "choice", "decision", "resolution"]),
    rejected: col(["rejected", "rejected options", "alternatives"]),
  };
  if (cols.topic === cols.chosen) throw new Error("topic and chosen columns must differ");
  const rows = [];
  for (i += 2; i < lines.length; i++) {
    const line = lines[i];
    if (isRow(line)) {
      if (isDivider(line)) continue;
      const cells = splitRow(line);
      rows.push({ topic: cells[cols.topic] ?? "", chosen: cells[cols.chosen] ?? "", rejected: cells[cols.rejected] ?? "" });
    } else if (line.trim() === "" && isRow(lines[i + 1] ?? "")) {
      continue;
    } else break;
  }
  return rows;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Turning rows into drafts ───────────────────────────────────────────────

const REVISION = /\s*\((v[0-9]+)\)\s*$/;

/** Strip a trailing "(vN)" marker, returning the text and the revision. */
export function takeRevision(text) {
  const m = text.match(REVISION);
  return m ? { text: text.slice(0, m.index).trim(), revision: m[1] } : { text: text.trim(), revision: null };
}

/** Semicolons inside backticks don't split. */
function splitOptions(cell) {
  const out = [];
  let cur = "";
  let inCode = false;
  for (const ch of cell) {
    if (ch === "`") inCode = !inCode;
    if (ch === ";" && !inCode) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function draftFromRow(row, { id, issue, state, decidedBy, decidedOn }) {
  const topic = takeRevision(row.topic);
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const options = [{ id: "a", label: takeRevision(row.chosen).text, how: null, tradeoff: null }];
  const supersedes = [];
  for (const raw of splitOptions(row.rejected)) {
    const { text, revision } = takeRevision(raw);
    const opt = { id: letters[options.length], label: text, how: null, tradeoff: null };
    if (revision) {
      opt.chosen_in = revision;
      supersedes.push({ revision, option: opt.id });
    }
    options.push(opt);
  }
  if (options.length > letters.length) throw new Error(`${topic.text}: more than ${letters.length} options`);
  const [owner, number] = issue.split("#");
  return {
    schema: 1,
    id,
    title: topic.text,
    state,
    area: null,
    source: { issue, row: row.topic, revision: topic.revision },
    question: null,
    options,
    choice: state === "proposed" || state === "withdrawn" ? null : { option: "a", reason: null },
    rejected: options.slice(1).map((o) => ({ option: o.id, why: null })),
    supersedes,
    evidence: [{ title: `${issue}, ${row.topic}`, url: `https://github.com/${owner}/issues/${number}` }],
    decided_by: decidedBy ?? null,
    decided_on: decidedOn ?? null,
    reviews: [],
    constrains: [],
  };
}

// ── Writing files ──────────────────────────────────────────────────────────

/** YAML limited to what JSON can say: every string is double-quoted with JSON
 * escapes, so no value depends on YAML's implicit typing. */
export function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  const scalar = (v) => (v === null ? "null" : typeof v === "string" ? JSON.stringify(v) : String(v));
  const isScalar = (v) => v === null || typeof v !== "object";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${scalar(item)}`;
        if (Array.isArray(item)) return `${pad}-\n${toYaml(item, indent + 2)}`;
        const body = toYaml(item, indent + 2).slice(indent + 2);
        return `${pad}- ${body}`;
      })
      .join("\n");
  }
  const lines = [];
  for (const [k, v] of Object.entries(value)) {
    if (isScalar(v)) lines.push(`${pad}${k}: ${scalar(v)}`);
    else if (Array.isArray(v) && v.length === 0) lines.push(`${pad}${k}: []`);
    else if (!Array.isArray(v) && Object.keys(v).length === 0) lines.push(`${pad}${k}: {}`);
    else lines.push(`${pad}${k}:\n${toYaml(v, indent + 2)}`);
  }
  return lines.join("\n");
}

function slug(title) {
  return title
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/, "");
}

export function renderFile(record) {
  return `---\n${toYaml(record)}\n---\n\n# ${record.title}\n`;
}

function fetchBody(issue) {
  const [repo, number] = issue.split("#");
  return execFileSync("gh", ["issue", "view", number, "--repo", repo, "--json", "body", "-q", ".body"], {
    encoding: "utf8",
  });
}

function runImport(opts) {
  if (!opts.issue || !/^[^/#\s]+\/[^/#\s]+#[0-9]+$/.test(opts.issue)) throw new Error("--issue <owner/repo#n> is required");
  if (!opts.prefix || !/^[a-z][a-z0-9]{0,15}$/.test(opts.prefix)) throw new Error("--prefix must match ^[a-z][a-z0-9]{0,15}$");
  const body = opts.body ? readFileSync(opts.body, "utf8") : fetchBody(opts.issue);
  const rows = readTable(body, opts.heading);
  if (rows.length === 0) throw new Error("the table has no rows");
  if (!opts.dryRun) mkdirSync(opts.dir, { recursive: true });
  let written = 0;
  let skipped = 0;
  rows.forEach((row, n) => {
    const id = `${opts.prefix}-${String(opts.start + n).padStart(3, "0")}`;
    const record = draftFromRow(row, { ...opts, id });
    const file = join(opts.dir, `${id}-${slug(record.title)}.md`);
    const existing = existsSync(opts.dir) ? readdirSync(opts.dir).find((f) => f.startsWith(`${id}-`)) : undefined;
    if (existing && !opts.force) {
      console.log(`skip  ${existing} (exists)`);
      skipped++;
      return;
    }
    if (opts.dryRun) console.log(`would write ${relative(root, file)}`);
    else {
      writeFileSync(file, renderFile(record));
      console.log(`wrote ${relative(root, file)}`);
    }
    written++;
  });
  console.log(`${rows.length} rows, ${written} ${opts.dryRun ? "to write" : "written"}, ${skipped} skipped`);
}

// ── Checking files ─────────────────────────────────────────────────────────

async function runCheck(opts) {
  const { default: yaml } = await import("js-yaml");
  const { default: Ajv } = await import("ajv");
  const schema = JSON.parse(readFileSync(join(DEFAULT_DIR, "decision.schema.json"), "utf8"));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const files = readdirSync(opts.dir).filter((f) => /^[a-z][a-z0-9]*-[0-9]{3,}-.*\.md$/.test(f)).sort();
  const ids = new Map();
  const problems = [];
  const records = [];
  for (const f of files) {
    const text = readFileSync(join(opts.dir, f), "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!m) {
      problems.push(`${f}: no front matter`);
      continue;
    }
    let record;
    try {
      record = yaml.load(m[1], { schema: yaml.JSON_SCHEMA });
    } catch (e) {
      problems.push(`${f}: ${e.message.split("\n")[0]}`);
      continue;
    }
    if (!validate(record)) {
      for (const e of validate.errors) problems.push(`${f}: ${e.dataPath || "/"} ${e.message}`);
      continue;
    }
    if (!f.startsWith(`${record.id}-`)) problems.push(`${f}: file name must start with its id ${record.id}`);
    if (ids.has(record.id)) problems.push(`${f}: id ${record.id} also used by ${ids.get(record.id)}`);
    ids.set(record.id, f);
    records.push([f, record]);
  }
  for (const [f, r] of records) {
    const optionIds = new Set(r.options.map((o) => o.id));
    if (optionIds.size !== r.options.length) problems.push(`${f}: option ids repeat`);
    const refs = [r.choice?.option, ...r.rejected.map((x) => x.option), ...r.supersedes.map((s) => s.option)].filter(Boolean);
    for (const o of refs) if (!optionIds.has(o)) problems.push(`${f}: option ${o} is not listed under options`);
    if (r.choice) {
      const covered = new Set([r.choice.option, ...r.rejected.map((x) => x.option)]);
      for (const o of optionIds) if (!covered.has(o)) problems.push(`${f}: option ${o} is neither chosen nor rejected`);
      if (r.rejected.some((x) => x.option === r.choice.option)) problems.push(`${f}: the chosen option is also rejected`);
    }
    for (const s of r.supersedes) if (s.decision && !ids.has(s.decision)) problems.push(`${f}: supersedes unknown ${s.decision}`);
    for (const c of r.constrains) if (/^[a-z][a-z0-9]*-[0-9]{3,}$/.test(c) && !ids.has(c)) problems.push(`${f}: constrains unknown ${c}`);
  }
  for (const p of problems) console.error(p);
  console.log(`${files.length} decision files, ${problems.length} problems`);
  if (problems.length) process.exitCode = 1;
}

// ── Main ───────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) console.log(USAGE);
    else if (opts.check) await runCheck(opts);
    else runImport(opts);
  } catch (e) {
    console.error(`import-decisions: ${e.message}\n${USAGE}`);
    process.exitCode = 2;
  }
}
