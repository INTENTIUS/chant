/**
 * Prior-art sweep: does any tool chant's audit rules credit now check something
 * chant does not, and does every credit still point at a rule that exists?
 *
 * The registry of tools is `PRIOR_ART` (packages/core/src/audit/prior-art.ts);
 * the credits are each lexicon's `audit-lineage.ts`. This script fetches each
 * tool's published rule index, extracts its rule ids, and compares three ways:
 *
 *   new upstream   ids the index has that the committed snapshot did not — a
 *                  rule the tool added since the last sweep, worth a look at
 *                  whether chant should check it too
 *   gone upstream  ids the snapshot had that the index no longer lists
 *   stale credit   ids a chant rule credits that the index does not list —
 *                  the upstream rule was renamed or removed, so the credit
 *                  and its URL need re-checking
 *
 * Tools with no machine-readable index (vendor docs, a validator, a scanner
 * whose rules live only in code) are listed as unsweepable and skipped; the
 * research that credited them is re-done by hand when their docs change.
 *
 *   npx tsx scripts/prior-art-sweep.ts                  # report against the snapshot
 *   npx tsx scripts/prior-art-sweep.ts --update-snapshot  # accept the current indexes
 *   npx tsx scripts/prior-art-sweep.ts --json           # machine-readable report
 *
 * Network: this reads public docs and the GitHub API (set GH_TOKEN to lift the
 * anonymous rate limit). It is a maintenance script and a scheduled workflow
 * (.github/workflows/prior-art-sweep.yml), never a test; chant's test suite
 * stays offline.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PRIOR_ART, resolveAuditCatalog, type PriorArtTool } from "../packages/core/src/audit/catalog";

const SNAPSHOT = resolve(import.meta.dirname, "prior-art/snapshot.json");
const args = new Set(process.argv.slice(2));
const update = args.has("--update-snapshot");
const asJson = args.has("--json");

type Extract = (body: string) => string[];
interface Source {
  /** Where the rule index lives. `api:` prefixes a GitHub contents API path whose entries' names are the ids. */
  url: string;
  extract?: Extract;
  /** Strip this suffix from GitHub directory entries (e.g. ".rego"). */
  stripSuffix?: string;
  /** Keep only directory entries matching this (e.g. octoscan's `rule_*.go` beside helpers). */
  only?: RegExp;
  /** Map a directory entry name to the id the tool's users know it by. */
  rename?: (name: string) => string;
}

/**
 * Comparison key per tool. Snapshots keep the ids as published; comparisons
 * fold the cosmetic differences between how a tool's docs spell an id and how
 * a chant credit does — actionlint's headings carry backticks, the GCP policy
 * library's constraint kinds are its template filenames in CamelCase with
 * "Constraint" inserted.
 */
const KEY: Partial<Record<PriorArtTool, (id: string) => string>> = {
  actionlint: (id) => id.replace(/`/g, "").toLowerCase(),
  "gcp-policy-library": (id) => id.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/constraint/g, ""),
  kics: (id) => id.toLowerCase().replace(/[^a-z0-9]/g, ""),
};
const keyFor = (tool: PriorArtTool, id: string) => (KEY[tool] ?? ((x: string) => x))(id);

const uniq = (xs: string[]) => [...new Set(xs)].sort();
const headings = (level: string): Extract => (body) =>
  uniq([...body.matchAll(new RegExp(`^${level} (.+?)\\s*$`, "gm"))].map((m) => m[1].replace(/\`/g, "").trim()));
const regexIds = (re: RegExp): Extract => (body) => uniq([...body.matchAll(re)].map((m) => m[1]));
const gh = (repo: string, path: string, ref = "main"): string => `api:https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}`;
const raw = (repo: string, path: string, ref = "main"): string => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

/**
 * One or more index sources per sweepable tool. A tool absent here is
 * unsweepable and reported as such rather than silently skipped. cfn_nag is
 * deliberately absent: its W/F rule ids live inside each Ruby rule file, not in
 * any index. So is the AWS Guard Rules Registry, whose rules are files nested
 * one directory per service with no flat listing. Both are re-checked by hand.
 */
const SOURCES: Partial<Record<PriorArtTool, Source[]>> = {
  zizmor: [{ url: raw("zizmorcore/zizmor", "docs/audits.md"), extract: headings("##") }],
  actionlint: [{ url: raw("rhysd/actionlint", "docs/checks.md"), extract: headings("##") }],
  poutine: [{ url: gh("boostsecurityio/poutine", "opa/rego/rules"), stripSuffix: ".rego" }],
  // octoscan's rule ids are what `octoscan scan --list-rules` prints; the README reproduces that list as bare bullets.
  octoscan: [{ url: raw("synacktiv/octoscan", "README.md", "master"), extract: regexIds(/^- ([a-z][a-z0-9-]+)$/gm) }],
  scorecard: [{ url: raw("ossf/scorecard", "docs/checks.md"), extract: headings("##") }],
  hadolint: [{ url: raw("hadolint/hadolint", "README.md", "master"), extract: regexIds(/\b(DL\d{4})\b/g) }],
  dockle: [{ url: raw("goodwithtech/dockle", "CHECKPOINT.md", "master"), extract: regexIds(/\b((?:CIS|DKL)-[A-Z]{2}-\d{4})\b/g) }],
  checkov: ["cloudformation", "kubernetes", "dockerfile", "arm", "terraform", "gitlab_ci"].map((fw) => ({
    url: `https://www.checkov.io/5.Policy%20Index/${fw}.html`,
    extract: regexIds(/\b(CKV2?_[A-Z0-9]+_\d+)\b/g),
  })),
  // KICS rows carry the query title and its UUID; credits use either the title or the query's snake_case directory name, so both are indexed and KEY folds the spelling.
  kics: [{ url: raw("Checkmarx/kics", "docs/queries/all-queries.md", "master"), extract: (body) => uniq([...body.matchAll(/^\|([^|<]+?)<br\/><sup><sub>([0-9a-f-]{36})<\/sub><\/sup>\|/gm)].flatMap((m) => [m[1].trim(), m[2]])) }],
  "cfn-lint": [{ url: raw("aws-cloudformation/cfn-lint", "docs/rules.md"), extract: regexIds(/^\| \[([EWI]\d{4})<a name=/gm) }],
  "kube-linter": [{ url: raw("stackrox/kube-linter", "docs/generated/checks.md"), extract: headings("##") }],
  "kube-score": [{ url: raw("zegl/kube-score", "README_CHECKS.md", "master"), extract: regexIds(/^\|\s*([a-z][a-z0-9-]+)\s*\|/gm) }],
  polaris: ["security", "efficiency", "reliability"].map((k) => ({
    url: raw("FairwindsOps/polaris", `docs/checks/${k}.md`, "master"),
    extract: regexIds(/^`([a-zA-Z][a-zA-Z0-9]+)` \|/gm),
  })),
  "psrule-azure": [{ url: "https://azure.github.io/PSRule.Rules.Azure/en/rules/", extract: regexIds(/\b(Azure\.[A-Za-z0-9]+\.[A-Za-z0-9]+)\b/g) }],
  "arm-ttk": [{ url: gh("Azure/arm-ttk", "arm-ttk/testcases/deploymentTemplate", "master"), stripSuffix: ".test.ps1" }],
  "bicep-linter": [{ url: "https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/linter", extract: regexIds(/linter-rule-([a-z0-9-]+)/g) }],
  "gcp-policy-library": [{ url: gh("GoogleCloudPlatform/policy-library", "policies/templates", "master"), stripSuffix: ".yaml" }],
  gitleaks: [{ url: raw("gitleaks/gitleaks", "config/gitleaks.toml", "master"), extract: regexIds(/^id\s*=\s*"([^"]+)"/gm) }],
  trufflehog: [{ url: gh("trufflesecurity/trufflehog", "pkg/detectors") }],
  // detect-secrets is credited by plugin class name (what a .secrets.baseline lists), which the README enumerates.
  "detect-secrets": [{ url: raw("Yelp/detect-secrets", "README.md", "master"), extract: regexIds(/\b([A-Z][A-Za-z0-9]+(?:Detector|HighEntropyString))\b/g) }],
  gixy: [{ url: gh("yandex/gixy", "gixy/plugins", "master"), stripSuffix: ".py" }],
  "gixy-ng": [{ url: gh("dvershinin/gixy", "gixy/plugins", "master"), stripSuffix: ".py" }],
};

interface ToolSnapshot { source: string[]; ids: string[] }
interface Snapshot { generatedAt: string; tools: Record<string, ToolSnapshot> }

async function fetchText(url: string): Promise<string> {
  const headers: Record<string, string> = { "user-agent": "chant-prior-art-sweep" };
  if (url.startsWith("api:")) {
    headers.accept = "application/vnd.github+json";
    if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const res = await fetch(url.replace(/^api:/, ""), { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function indexFor(tool: PriorArtTool): Promise<{ ids: string[]; errors: string[] }> {
  const ids: string[] = []; const errors: string[] = [];
  for (const src of SOURCES[tool] ?? []) {
    try {
      const body = await fetchText(src.url);
      if (src.url.startsWith("api:")) {
        const entries = JSON.parse(body) as Array<{ name: string; type: string }>;
        for (const e of entries) {
          if (e.name.startsWith(".") || e.name.startsWith("_") || /^(README|LICENSE)/i.test(e.name)) continue;
          // Skip a tool's own unit tests, unless the ids themselves are test files (arm-ttk's `*.test.ps1`).
          if (!(src.stripSuffix ?? "").includes("test") && /(_|\.)test\./i.test(e.name)) continue;
          if (src.only && !src.only.test(e.name)) continue;
          const bare = src.stripSuffix && e.name.endsWith(src.stripSuffix) ? e.name.slice(0, -src.stripSuffix.length) : e.name.replace(/\.[a-z]+$/, "");
          ids.push(src.rename ? src.rename(bare) : bare);
        }
      } else if (src.extract) {
        const found = src.extract(body);
        if (found.length === 0) errors.push(`${src.url}: fetched, but the extractor found no rule ids (index format changed?)`);
        ids.push(...found);
      }
    } catch (err) {
      errors.push(`${src.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ids: uniq(ids), errors };
}

const lexicons = readdirSync(resolve(import.meta.dirname, "../lexicons"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const catalog = await resolveAuditCatalog(lexicons);
const credited = new Map<string, Map<string, string[]>>(); // tool -> upstream rule -> chant ids
for (const m of Object.values(catalog)) {
  for (const l of m.lineage ?? []) {
    if (!l.rule) continue;
    const byRule = credited.get(l.tool) ?? new Map<string, string[]>();
    byRule.set(l.rule, [...(byRule.get(l.rule) ?? []), m.id]);
    credited.set(l.tool, byRule);
  }
}

const previous: Snapshot | undefined = existsSync(SNAPSHOT) ? (JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot) : undefined;
const next: Snapshot = { generatedAt: new Date().toISOString(), tools: {} };
interface ToolReport { tool: string; name: string; fetched: number; errors: string[]; newUpstream: string[]; goneUpstream: string[]; staleCredits: Array<{ rule: string; chant: string[] }> }
const reports: ToolReport[] = []; const unsweepable: string[] = [];

for (const tool of Object.keys(PRIOR_ART) as PriorArtTool[]) {
  if (!SOURCES[tool]) { unsweepable.push(tool); continue; }
  const { ids, errors } = await indexFor(tool);
  const k = (id: string) => keyFor(tool, id);
  const prev = new Set((previous?.tools[tool]?.ids ?? []).map(k));
  const now = new Set(ids.map(k));
  const stale = ids.length === 0 ? [] : [...(credited.get(tool) ?? new Map())].filter(([r]) => !now.has(k(r))).map(([rule, chant]) => ({ rule, chant }));
  reports.push({
    tool, name: PRIOR_ART[tool].name, fetched: ids.length, errors,
    newUpstream: previous ? ids.filter((i) => !prev.has(k(i))) : [],
    goneUpstream: previous ? (previous.tools[tool]?.ids ?? []).filter((i) => !now.has(k(i))).sort() : [],
    staleCredits: stale,
  });
  next.tools[tool] = { source: (SOURCES[tool] ?? []).map((s) => s.url), ids: ids.length > 0 ? ids : (previous?.tools[tool]?.ids ?? []) };
}

if (update) {
  writeFileSync(SNAPSHOT, JSON.stringify(next, null, 2) + "\n");
}

if (asJson) {
  console.log(JSON.stringify({ generatedAt: next.generatedAt, previous: previous?.generatedAt, reports, unsweepable }, null, 2));
} else {
  const lines: string[] = [];
  lines.push(`# Prior-art sweep — ${next.generatedAt.slice(0, 10)}${previous ? ` (against snapshot ${previous.generatedAt.slice(0, 10)})` : " (no snapshot yet)"}`, "");
  const changed = reports.filter((r) => r.newUpstream.length || r.goneUpstream.length || r.staleCredits.length || r.errors.length);
  if (changed.length === 0) lines.push("Nothing changed: every swept index matches the snapshot and every credit still resolves.", "");
  for (const r of changed) {
    lines.push(`## ${r.name} (${r.tool}) — ${r.fetched} upstream rules`);
    for (const e of r.errors) lines.push(`- fetch failed: ${e}`);
    if (r.newUpstream.length) lines.push(`- new upstream (${r.newUpstream.length}): ${r.newUpstream.map((i) => `\`${i}\``).join(", ")}`);
    if (r.goneUpstream.length) lines.push(`- gone upstream (${r.goneUpstream.length}): ${r.goneUpstream.map((i) => `\`${i}\``).join(", ")}`);
    for (const s of r.staleCredits) lines.push(`- stale credit: \`${s.rule}\` is cited by ${s.chant.join(", ")} but the index no longer lists it`);
    lines.push("");
  }
  lines.push(`Swept ${reports.length} tools; ${reports.reduce((n, r) => n + r.fetched, 0)} upstream rules indexed. Unsweepable (no machine-readable index): ${unsweepable.join(", ")}.`);
  if (update) lines.push("", `Snapshot written to ${SNAPSHOT}.`);
  console.log(lines.join("\n"));
}
