// Prose lint for the docs site, on the `sentences` trope ruleset — the
// AI-writing tells (em-dash density, colon reveals, tricolons, anaphora,
// bold-first bullets, …) that tropes.fyi catalogues and the package detects
// per sentence with real parse trees, not regexes.
//
// Same posture as scripts/typecheck.ts: a RATCHET, not a purity gate. The
// docs corpus predates the linter; every existing finding is baselined
// per (file, rule) in scripts/docs-sentences-baseline.json, and this script
// fails only on a count that GREW — new prose is linted from its first
// commit, old debt is visible and burns down monotonically. When a count
// drops, run with --update-baseline and commit the tightened file, so the
// improvement can't regress either.
//
//   node scripts/lint-docs-sentences.mjs               # gate (CI)
//   node scripts/lint-docs-sentences.mjs --verbose     # every finding, file:line
//   node scripts/lint-docs-sentences.mjs --update-baseline
//
// Only `medium` and `high` severities gate; `candidate`/`low` print under
// --verbose but never fail the build — the low tiers are leads, not verdicts.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "sentences/lint/registry";
import { runRules } from "sentences/lint/engine";
import { buildDocAnalysis } from "sentences/lint/build-doc";
import { extractProse } from "sentences/lint/markdown-prose";
import { neverLine } from "../docs/src/prompts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(here, "..", "docs", "src", "content", "docs");
const BASELINE = join(here, "docs-sentences-baseline.json");
const GATED_SEVERITIES = new Set(["medium", "high"]);

/**
 * Rules that gate at whatever severity they carry (chant#2470).
 *
 * `reframe` is the "It is not X. It is Y." shape — the first pattern on the
 * writing guide and the one the user objects to by name. It fires at `low`, so
 * `GATED_SEVERITIES` alone would never stop it. Widening that set is the wrong
 * lever: `low` is where the bulk lives (913 findings here), and admitting it
 * would gate all of them at once.
 *
 * Measured before switching it on, over chant, typescript-as-data and a
 * 32-file prose corpus outside both: seven findings, five real. The two wrong
 * ones cost a baseline line each, once, which is what a ratchet is for.
 */
const ALWAYS_GATED_RULES = new Set(["reframe"]);

const verbose = process.argv.includes("--verbose");
const updateBaseline = process.argv.includes("--update-baseline");

/**
 * Each lexicon's section, docs/src/content/docs/lexicons/<name>/, is build
 * output: scripts/build-docs.sh generates it from lexicons/<name>/docs/pages/
 * (chant #3993). It is left out, so the result does not depend on whether a
 * build ran first and the baseline never grows to make room for it.
 * lexicons/overview.mdx is a core page and stays in.
 */
const LEXICON_SECTIONS = join(DOCS_ROOT, "lexicons");

function docFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory() && dir === LEXICON_SECTIONS) continue;
    if (statSync(p).isDirectory()) out.push(...docFiles(p));
    else if (/\.(md|mdx)$/.test(entry)) out.push(p);
  }
  return out.sort();
}

/**
 * A page's agent prompt (`prompt: |` in the front matter, chant #3996) is
 * prose a reader copies, so it is linted like the body. On a page that has
 * one, the rest of the front matter is blanked: its YAML keys and short values
 * would otherwise run into the prompt as one sentence. Two of the prompt's
 * lines are blanked as well. The never-line every prompt ends with is the
 * same sentence on every task page, written once in docs/src/prompts.mjs and
 * held word for word by scripts/lint-prompts.mjs, and the "Read <the page's
 * URL>." line a prompt opens with reads as a fragment once the URL is taken
 * out. A page with no prompt block gets the same treatment less the prompt:
 * only its description is kept (chant#4518). Before that, the fences, the
 * title and keys like `diataxis:` ran together into one "sentence" that
 * counted as a colon reveal on every page. A one-line prompt
 * (`prompt: setup`) names the setup prompt in prompts.mjs and is dropped
 * with the other keys. Every line keeps its place, so lines still map onto
 * the source file.
 */
const READ_PAGE = /^\s*Read https:\/\/intentius\.io\/chant\/\S*\.$/;
const PROMPT_BLOCK = /^prompt:\s*[|>][+-]?\s*$/;

function promptProse(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const m = /^---\n([\s\S]*?)\n---(?=\n|$)/.exec(text);
  if (!m) return text;
  const lines = m[0].split("\n");
  let inPrompt = false;
  const kept = lines.map((line) => {
    if (PROMPT_BLOCK.test(line)) {
      inPrompt = true;
      return "";
    }
    if (inPrompt && (line === "" || /^\s/.test(line))) return line.includes(neverLine) || READ_PAGE.test(line) ? blank(line) : line;
    inPrompt = false;
    // A description is reader-facing prose: keep its value, blank only the key.
    const desc = /^(description:\s*)(.*)$/.exec(line);
    if (desc) return blank(desc[1]) + desc[2];
    // Emptied, not blanked to spaces, so the description and the prompt stay
    // separate paragraphs; line numbers are unchanged.
    return "";
  });
  return kept.join("\n") + text.slice(m[0].length);
}

/**
 * Reference labels that open a paragraph or a list item: `**Fix:**` and
 * `**Severity:**` on the lint-rule pages, `**Symptom:**` and `**Cause:**` on
 * the troubleshooting pages. Each is a field name, not a sentence, and the
 * colon-reveal rule read every one as a nameplate (chant#4518). The label is
 * blanked to spaces, so the sentence after it is still linted and offsets
 * hold. A thematic break (a `---` line between sections) is blanked too:
 * with the labels gone, the breaks that close each rule's section were read
 * as the opening word of three sentences in a row. So is an MDX page's
 * `import ... from '...'` line, which is code: config-file.mdx's two snippet
 * imports read as five fragments and two near-duplicate sentences.
 */
const REFERENCE_LABEL = /^(\s*(?:[-*+]\s+)?)\*\*(?:Fix|Severity|Symptom|Cause):\*\*/gm;
const THEMATIC_BREAK = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm;
const MDX_IMPORT = /^import\s[^\n]*\sfrom\s+(['"])[^'"\n]+\1;?[ \t]*$/gm;

function blankNonProse(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  return text
    .replace(REFERENCE_LABEL, (all, lead) => lead + blank(all.slice(lead.length)))
    .replace(THEMATIC_BREAK, blank)
    .replace(MDX_IMPORT, blank);
}

/** 1-based line of a prose-text offset — extractProse blanks non-prose but
 * preserves every offset, so spans map straight onto the source file. */
function lineOf(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

const files = docFiles(DOCS_ROOT);
const current = {}; // relPath -> ruleId -> count (gated severities only)
let total = 0;
let gated = 0;
const detail = [];

for (const file of files) {
  const rel = relative(join(here, ".."), file);
  const text = readFileSync(file, "utf8");
  const prose = extractProse(blankNonProse(promptProse(text)));
  const doc = buildDocAnalysis(prose);
  const { findings, errors } = runRules(RULES, doc);
  for (const e of errors) detail.push(`${rel}: rule ${e.ruleId} errored: ${e.message}`);
  for (const f of findings) {
    total++;
    if (verbose) detail.push(`${rel}:${lineOf(prose, f.span.start)} [${f.severity}] ${f.ruleId} — ${f.message}`);
    if (!GATED_SEVERITIES.has(f.severity) && !ALWAYS_GATED_RULES.has(f.ruleId)) continue;
    gated++;
    const perFile = (current[rel] ??= {});
    perFile[f.ruleId] = (perFile[f.ruleId] ?? 0) + 1;
  }
}

if (verbose) for (const line of detail) console.log(line);

if (updateBaseline) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 1) + "\n");
  console.log(`Docs prose lint: baseline written — ${gated} gated finding(s) across ${Object.keys(current).length} file(s) (${total} total incl. low tiers).`);
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(`Docs prose lint: no baseline at ${relative(process.cwd(), BASELINE)} — run with --update-baseline once and commit it.`);
  process.exit(1);
}

const regressions = [];
for (const [file, rules] of Object.entries(current)) {
  for (const [rule, count] of Object.entries(rules)) {
    const allowed = baseline[file]?.[rule] ?? 0;
    if (count > allowed) regressions.push(`${file}: ${rule} ${allowed} -> ${count}`);
  }
}

const baselineTotal = Object.values(baseline).reduce(
  (n, rules) => n + Object.values(rules).reduce((m, c) => m + c, 0),
  0,
);

if (regressions.length > 0) {
  console.error(`Docs prose lint: ${regressions.length} regression(s) against the baseline:`);
  for (const r of regressions) console.error(`  ${r}`);
  console.error("Fix the prose (rerun with --verbose for file:line), or — only for a deliberate style decision — --update-baseline and commit.");
  process.exit(1);
}

if (gated < baselineTotal) {
  console.log(`Docs prose lint: ${gated} gated finding(s), no regressions — ${baselineTotal - gated} BELOW the baseline of ${baselineTotal}; ratchet it down with --update-baseline.`);
} else {
  console.log(`Docs prose lint: ${gated} gated finding(s), no regressions. (${baselineTotal} baselined)`);
}
