#!/usr/bin/env node
// The "Optional: hand this page to your coding agent" prompts (chant #3996),
// held to the rules terragucci's scripts/lint-prompts.mjs set:
//
// - each prompt names its own page's URL (`prompt: setup` names the agents
//   page, so a page whose task is the setup itself carries it instead);
// - each carries the never-line in docs/src/prompts.mjs word for word, so no
//   prompt can drop the real account, the approval, the override, the merge,
//   the release, the `ci/*` tags, the flag values, the signers file or
//   chant/lifecycle;
// - every `diataxis: tutorial` and `diataxis: how-to` page has one, core and
//   lexicon (scripts/check-docs-diataxis.mjs holds that field equal to the
//   sidebar group the page sits in);
// - a sentence that names the signers file or chant/lifecycle forbids it;
// - a sentence that has the agent run `chant run` passes `--no-record` or sets
//   CHANT_NO_RECORD, since a recorded run writes and pushes chant/lifecycle;
// - a sentence that does not forbid them has the agent run neither
//   `chant release cut --yes` nor `chant release publish`, push or delete no
//   `ci/*` tag (`chant ci tick` without `--dry-run` pushes them), prune
//   chant/lifecycle with `chant lifecycle gc --yes`, or change a flag's value
//   (chant #4038): people cut and publish releases, and the tick and people
//   own the tags and the flags;
// - every room's First step carries a prompt (`'setup'` or one that names the
//   room's page), from docs/src/data/rooms.mjs;
// - the setup prompt has one source, docs/src/prompts.mjs, and README.md, the
//   agents page and the home page carry it.
//
// Core pages are read from docs/src/content/docs. Lexicon pages are read from
// their authored sources, lexicons/<name>/docs/pages/, so the check needs no
// build; a lexicon's overview page is generated from its src/codegen/docs.ts,
// and its prompt is checked when scripts/build-docs.sh has written it.
//
//   node scripts/lint-prompts.mjs            # exit 1 on any problem
//   node scripts/lint-prompts.mjs --print    # also print every page's prompt
//
// CHANT_PROMPTS_ROOT points the check at another repository root (tests use a
// fixture with the same layout).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { neverLine, pageUrl, promptText, setupPrompt } from "../docs/src/prompts.mjs";
import { ROOMS } from "../docs/src/data/rooms.mjs";

const TASK_QUADRANTS = new Set(["tutorial", "how-to"]);

/** The front matter's top-level fields, one line each (a `|` block's first line is just `|`). */
function fields(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const out = {};
  for (const line of front.split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** A page's `prompt:` front matter as its text: one line, or a `|` or `>` block. `setup` is the setup prompt. */
export function frontPrompt(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const lines = front.split("\n");
  const at = lines.findIndex((l) => /^prompt:/.test(l));
  if (at === -1) return undefined;
  const head = lines[at].slice("prompt:".length).trim();
  if (!/^[|>][+-]?$/.test(head)) return promptText(head.replace(/^(["'])(.*)\1$/, "$2")) ?? "";
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    block.push(line.replace(/^ {2}/, ""));
  }
  const body = block.join("\n").trim();
  return promptText(head.startsWith(">") ? body.replace(/\n(?!\n)/g, " ") : body) ?? "";
}

const sentences = (prompt) => prompt.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
const forbids = (s) => /\b(never|do not|don't)\b/i.test(s);
const flat = (text) => text.replace(/\s+/g, " ");

// The never-line's parts, each named when a prompt lacks it.
const NEVER_PARTS = [
  ["Never deploy to a real cloud account or shared environment", "the real account or shared environment"],
  ["(with `chant run`, `chant components` or a platform's own CLI)", "the deploy commands"],
  ["approve (a pull request review, `chant approve` or `chant run approve`)", "the approvals"],
  ["override a policy denial (`chant approve policy-override`)", "the override"],
  ["or merge;", "merge"],
  ["never cut or publish a release (`chant release cut --yes` or `chant release publish`)", "the release"],
  ["push or delete a `ci/*` tag (`chant ci tick` pushes them)", "the ci/* tags"],
  ["or change the value of an existing flag;", "the flag values"],
  ["never touch `.chant/allowed_signers`", "the signers file"],
  ["or `chant/lifecycle`.", "chant/lifecycle"],
];

// `chant run` subcommands that run no Op and record nothing.
const RUN_READS = /^chant run (--generate|list|status|log)\b/;

/**
 * What a sentence has the agent do that only people (or the tick) do, as the
 * problem to report, or undefined (chant #4038). The sentence is one that does
 * not forbid it. A dry run of the cut (`chant release cut` without `--yes`),
 * `chant ci tick --dry-run`, and reading the tags (`git fetch`, `chant ci
 * list`) pass.
 */
export function releaseProblems(s) {
  const out = [];
  for (const [, cmd] of s.matchAll(/`([^`]*)`/g)) {
    if (/\bchant release cut\b/.test(cmd) && /(^|\s)(--yes|-y)\b/.test(cmd)) out.push(`"${cmd}" cuts a release; have the agent run the dry run, without --yes, and leave the cut to a person`);
    if (/\bchant release publish\b/.test(cmd)) out.push(`"${cmd}" publishes a release; only a person or the release pipeline publishes`);
    if (/\bchant ci tick\b/.test(cmd) && !/--dry-run\b/.test(cmd)) out.push(`"${cmd}" pushes ci/* tags; pass --dry-run, or leave the tick to CI`);
    if (/\bgit (push|tag)\b/.test(cmd) && /\bci\//.test(cmd)) out.push(`"${cmd}" pushes, moves or deletes a ci/* tag; only the tick and people do that`);
    if (/\bchant lifecycle gc\b/.test(cmd) && /(^|\s)--yes\b/.test(cmd)) out.push(`"${cmd}" prunes chant/lifecycle; have the agent run the dry run, without --yes`);
  }
  const prose = s.replace(/`[^`]*`/g, "");
  if (/\b(push|delete|remove|move)\w*\b/i.test(prose) && /\bci\/(\*|green|revoked)/.test(s) && !/`[^`]*\bgit fetch\b/.test(s)) {
    out.push(`"${s}" has the agent push, move or delete a ci/* tag; only the tick and people do that`);
  }
  if (/\bflags?\b/i.test(prose) && (/\b(flip|toggle)\w*\b/i.test(prose) || /\bturn\w*\b[^.;]*\b(on|off)\b/i.test(prose) || /\b(change|edit|update)\w*\b[^.;]*\bvalues?\b/i.test(prose))) {
    out.push(`"${s}" has the agent change a flag's value; a person does that in a reviewed change`);
  }
  return out;
}

/** Problems with one prompt, `url` the address it must name (none for the setup prompt), `where` for the messages. */
export function checkPrompt(prompt, url, where) {
  const problems = [];
  if (!prompt.trim()) return [`${where}: an empty \`prompt:\`; write one, or remove the field`];
  if (url && prompt !== setupPrompt && !prompt.includes(url)) problems.push(`${where}: the prompt does not name its page, ${url}`);
  if (!flat(prompt).includes(neverLine)) {
    const missing = NEVER_PARTS.filter(([text]) => !flat(prompt).includes(text)).map(([, part]) => part);
    const what = missing.length ? `misses ${missing.join(", ")}` : "words it differently";
    problems.push(`${where}: the prompt ${what}; end it with the never-line from docs/src/prompts.mjs: "${neverLine}"`);
  }
  for (const s of sentences(prompt)) {
    if (forbids(s)) continue;
    if (/allowed_signers|chant\/lifecycle/.test(s)) problems.push(`${where}: "${s}" lets the agent near the signers file or chant/lifecycle; only people touch those`);
    for (const [, cmd] of s.matchAll(/`([^`]*\bchant run\b[^`]*)`/g)) {
      const run = cmd.slice(cmd.indexOf("chant run"));
      if (RUN_READS.test(run) || /--no-record\b/.test(cmd) || /CHANT_NO_RECORD/.test(s)) continue;
      problems.push(`${where}: "${cmd}" records on chant/lifecycle and pushes it; pass --no-record (or set CHANT_NO_RECORD=1)`);
    }
    for (const p of releaseProblems(s)) problems.push(`${where}: ${p}`);
  }
  return problems;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.mdx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Every page the check reads, as { file, slug, quadrant, prompt }: the core
 * pages (a lexicon's generated section left out, except its overview), and
 * each lexicon's authored pages under the slug the docs pipeline gives them.
 */
export function pages(root) {
  const content = join(root, "docs", "src", "content", "docs");
  const lexiconSections = join(content, "lexicons");
  const out = [];
  const add = (file, slug) => {
    const text = readFileSync(file, "utf8");
    out.push({ file: relative(root, file), slug, quadrant: fields(text).diataxis, prompt: frontPrompt(text) });
  };
  for (const file of walk(content)) {
    const rel = relative(content, file);
    const section = relative(lexiconSections, file);
    const inSection = !section.startsWith("..") && section.includes("/");
    // A generated lexicon page is checked from its source below; the overview
    // has no source page, so it is checked here when it was generated.
    if (inSection && !/^[^/]+\/index\.mdx?$/.test(section)) continue;
    add(file, rel.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, ""));
  }
  const lexicons = join(root, "lexicons");
  if (existsSync(lexicons)) {
    for (const lex of readdirSync(lexicons).sort()) {
      const dir = join(lexicons, lex, "docs", "pages");
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) {
        if (/\.mdx?$/.test(name)) add(join(dir, name), `lexicons/${lex}/${name.replace(/\.mdx?$/, "")}`);
      }
    }
  }
  return out;
}

/** Every problem in the repository at `root`. */
export function promptProblems(root) {
  const problems = [];
  const all = pages(root);
  for (const p of all) {
    if (p.prompt !== undefined) problems.push(...checkPrompt(p.prompt, pageUrl(p.slug), p.file));
    else if (TASK_QUADRANTS.has(p.quadrant)) {
      problems.push(`${p.file}: a ${p.quadrant} page with no \`prompt:\` front matter; add one that names ${pageUrl(p.slug)} and ends with the never-line, or \`prompt: setup\` when the page's task is the setup`);
    }
  }

  for (const r of ROOMS) {
    const prompt = promptText(r.first?.prompt);
    const where = `docs/src/data/rooms.mjs: room ${r.id}`;
    if (!prompt) problems.push(`${where}: First step has no prompt; set first.prompt to 'setup' or a prompt that names ${pageUrl(`for/${r.id}`)}`);
    else problems.push(...checkPrompt(prompt, pageUrl(`for/${r.id}`), where));
  }

  if (!setupPrompt.includes(neverLine)) problems.push("docs/src/prompts.mjs: the setup prompt does not carry neverLine");
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "");
  if (!read("README.md").includes("```text\n" + setupPrompt + "\n```")) {
    problems.push("README.md: the setup prompt is not the one in docs/src/prompts.mjs; copy it from there into a ```text block");
  }
  const agents = all.find((p) => p.slug === "agents");
  if (agents?.prompt !== setupPrompt) problems.push("docs/src/content/docs/agents.mdx: carry the setup prompt with `prompt: setup`");
  if (!read("docs/src/components/Landing.astro").includes("text={setupPrompt}")) {
    problems.push('docs/src/components/Landing.astro: render <AgentPrompt text={setupPrompt} /> for part="agent"');
  }
  if (!/<Landing part="agent" \/>\s*$/.test(read("docs/src/content/docs/index.mdx"))) {
    problems.push('docs/src/content/docs/index.mdx: end the home page with <Landing part="agent" />, the setup prompt card');
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.env.CHANT_PROMPTS_ROOT ?? join(fileURLToPath(import.meta.url), "..", "..");
  const all = pages(root);
  if (process.argv.includes("--print")) {
    for (const p of all.filter((x) => x.prompt !== undefined)) console.log(`${p.slug}\n${p.prompt.replace(/^/gm, "  ")}\n`);
  }
  const problems = promptProblems(root);
  const lexicon = (p) => p.slug.startsWith("lexicons/") && p.slug !== "lexicons/overview";
  const carried = (list) => list.filter((p) => p.prompt !== undefined).length;
  const tasks = (list) => list.filter((p) => TASK_QUADRANTS.has(p.quadrant)).length;
  const setup = all.filter((p) => p.prompt === setupPrompt).length;
  console.log(
    `prompts: ${carried(all.filter((p) => !lexicon(p)))} core pages (${tasks(all.filter((p) => !lexicon(p)))} tutorial or how-to), ` +
      `${carried(all.filter(lexicon))} lexicon pages (${tasks(all.filter(lexicon))} tutorial or how-to), ${setup} with prompt: setup, ${ROOMS.length} rooms`,
  );
  for (const p of problems) console.log(`FAIL prompt  ${p}`);
  if (problems.length) console.log(`${problems.length} problem(s)`);
  process.exit(problems.length ? 1 : 0);
}
