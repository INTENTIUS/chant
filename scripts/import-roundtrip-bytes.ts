/**
 * Byte-level import round trip.
 *
 * For each real input under test/import-roundtrip/{aws,k8s}: `chant import`,
 * then `chant build`, then compare the original and the rebuilt document after
 * canonical ordering. Writes test/import-roundtrip/results.json and results.md.
 *
 *   npx tsx scripts/import-roundtrip-bytes.ts            # measure all, write results
 *   npx tsx scripts/import-roundtrip-bytes.ts --only k8s # one lexicon
 *   npx tsx scripts/import-roundtrip-bytes.ts --no-write # print only
 *
 * Canonical form
 *   Every document is parsed (JSON, or YAML with the CloudFormation short-form
 *   tags rewritten to their long form), every mapping has its keys sorted
 *   recursively, and the result is printed as JSON with two-space indent.
 *   Arrays keep their order. A CloudFormation template is one document. A
 *   Kubernetes file may hold several: the documents are sorted by
 *   apiVersion, kind, namespace and name and joined with "---". Comments,
 *   quoting style, indentation and key order are outside the measure because
 *   parsing removes them. Two inputs are byte-identical when their canonical
 *   forms are the same string.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const exec = promisify(execFile);

// --- canonical form ---------------------------------------------------------

const CFN_TAGS = [
  "Base64", "Cidr", "FindInMap", "GetAtt", "GetAZs", "ImportValue", "Join", "Select", "Split",
  "Sub", "Transform", "Equals", "If", "Not", "And", "Or", "Condition", "Ref", "ForEach", "Length",
  "ToJsonString", "Contains", "EachMemberEquals", "EachMemberIn", "RefAll", "ValueOf", "ValueOfAll",
];

function cfnTagToLong(tag: string, value: unknown): unknown {
  if (tag === "Ref") return { Ref: value };
  if (tag === "Condition") return { Condition: value };
  if (tag === "GetAtt" && typeof value === "string") {
    const i = value.indexOf(".");
    return { "Fn::GetAtt": i < 0 ? [value] : [value.slice(0, i), value.slice(i + 1)] };
  }
  return { [`Fn::${tag}`]: value };
}

const cfnSchema = yaml.DEFAULT_SCHEMA.extend(
  CFN_TAGS.flatMap((tag) =>
    (["scalar", "sequence", "mapping"] as const).map(
      (kind) => new yaml.Type(`!${tag}`, { kind, construct: (data: unknown) => cfnTagToLong(tag, data) }),
    ),
  ),
);

export function parseTemplate(text: string, lexicon: "aws" | "k8s"): unknown[] {
  const trimmed = text.trimStart();
  if (lexicon === "aws") {
    if (trimmed.startsWith("{")) return [JSON.parse(text)];
    return [yaml.load(text, { schema: cfnSchema })];
  }
  if (trimmed.startsWith("{")) return [JSON.parse(text)];
  return yaml.loadAll(text).filter((d) => d !== null && d !== undefined);
}

export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
  }
  return v;
}

function docIdentity(d: any): string {
  return [d?.kind ?? "", d?.metadata?.namespace ?? "", d?.metadata?.name ?? ""].join("/");
}

export function canonicalDocs(text: string, lexicon: "aws" | "k8s"): { id: string; doc: unknown }[] {
  const docs = parseTemplate(text, lexicon);
  const items = docs.map((doc) => ({ id: lexicon === "aws" ? "template" : docIdentity(doc), doc: sortKeys(doc) }));
  if (lexicon === "k8s") items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return items;
}

export function canonicalText(text: string, lexicon: "aws" | "k8s"): string {
  return canonicalDocs(text, lexicon).map((d) => JSON.stringify(d.doc, null, 2)).join("\n---\n") + "\n";
}

// --- difference classification ---------------------------------------------

export type Reason =
  | "section-dropped"
  | "field-dropped"
  | "field-added"
  | "type-coercion"
  | "intrinsic-form"
  | "value-changed"
  | "api-version-changed"
  | "empty-value-collapsed"
  | "array-order"
  | "array-length"
  | "document-missing"
  | "document-added";

export interface Difference {
  reason: Reason;
  path: string;
  before?: unknown;
  after?: unknown;
}

function isIntrinsic(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  return keys.length === 1 && (keys[0] === "Ref" || keys[0].startsWith("Fn::") || keys[0] === "Condition");
}

function scalar(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

export function diffValues(a: unknown, b: unknown, path: string, out: Difference[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (isIntrinsic(a) || isIntrinsic(b)) {
    out.push({ reason: "intrinsic-form", path, before: a, after: b });
    return;
  }
  if (path.endsWith(".apiVersion") && scalar(a) && scalar(b)) {
    out.push({ reason: "api-version-changed", path, before: a, after: b });
    return;
  }
  if (/^(\[\{\}\]|\{\}|\[\])$/.test(JSON.stringify(a)) && (b === null || b === undefined || JSON.stringify(b) !== JSON.stringify(a))) {
    out.push({ reason: "empty-value-collapsed", path, before: a, after: b });
    return;
  }
  if (scalar(a) && scalar(b)) {
    if (a !== null && b !== null && String(a) === String(b)) out.push({ reason: "type-coercion", path, before: a, after: b });
    else out.push({ reason: "value-changed", path, before: a, after: b });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ reason: "array-length", path, before: a.length, after: b.length });
      return;
    }
    const sa = a.map((x) => JSON.stringify(x)).sort();
    const sb = b.map((x) => JSON.stringify(x)).sort();
    if (JSON.stringify(sa) === JSON.stringify(sb)) {
      out.push({ reason: "array-order", path });
      return;
    }
    a.forEach((x, i) => diffValues(x, b[i], `${path}[${i}]`, out));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const top = path === "";
    for (const k of Object.keys(ao)) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in bo)) out.push({ reason: top ? "section-dropped" : "field-dropped", path: p, before: ao[k] });
      else diffValues(ao[k], bo[k], p, out);
    }
    for (const k of Object.keys(bo)) {
      if (!(k in ao)) out.push({ reason: "field-added", path: path ? `${path}.${k}` : k, after: bo[k] });
    }
    return;
  }
  out.push({ reason: "value-changed", path, before: a, after: b });
}

export function diffCanonical(before: string, after: string, lexicon: "aws" | "k8s"): Difference[] {
  const a = canonicalDocs(before, lexicon);
  const b = canonicalDocs(after, lexicon);
  const out: Difference[] = [];
  const bById = new Map(b.map((d) => [d.id, d]));
  const aIds = new Set(a.map((d) => d.id));
  for (const d of a) {
    const other = bById.get(d.id);
    if (!other) out.push({ reason: "document-missing", path: d.id });
    else diffValues(d.doc, other.doc, lexicon === "aws" ? "" : d.id + ":", out);
  }
  for (const d of b) if (!aIds.has(d.id)) out.push({ reason: "document-added", path: d.id });
  return out;
}

// --- running the CLI -------------------------------------------------------

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(root, "test", "import-roundtrip");
const chantBin = join(root, "packages", "core", "bin", "chant");

const ansi = /\u001b\[[0-9;]*m/g;
const clean = (s: string) => s.replace(ansi, "");

async function chant(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await exec(chantBin, args, { cwd, env: { ...process.env, TSX_DISABLE_CACHE: "1", NO_COLOR: "1" }, maxBuffer: 64 * 1024 * 1024, timeout: 240_000 });
    return { ok: true, out: clean(r.stdout + r.stderr) };
  } catch (e: any) {
    return { ok: false, out: clean(String(e.stdout ?? "") + String(e.stderr ?? "") + String(e.message ?? "")) };
  }
}

export interface Entry {
  file: string;
  lexicon: "aws" | "k8s";
  source: string;
  license: string;
  status: "identical" | "different" | "import-failed" | "build-failed";
  reasons: Reason[] | string[];
  differences: Difference[];
  importWarnings: string[];
  detail?: string;
  sourceHasComments: boolean;
}

export function failureClass(detail: string): string {
  if (/stackOutput\(ref\)/.test(detail)) return "output-of-a-bare-Ref";
  if (/Cannot embed Declarable directly in Sub/.test(detail)) return "Sub-embeds-a-resource";
  if (/is not defined|does not provide an export/.test(detail)) return "generated-file-references-missing-name";
  if (/Transform failed|SyntaxError|Unexpected/.test(detail)) return "generated-source-does-not-compile";
  if (/unknown tag/.test(detail)) return "unknown-yaml-tag";
  if (/hardcoded value for sensitive env var|\(k8s\)|\(aws\)/.test(detail)) return "build-check-error";
  return "other";
}

function firstError(out: string): string {
  const line = out.split("\n").find((l) => /error/i.test(l)) ?? out.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/\/[^\s]*\.rt-[^\s/]*\//g, "").replace(/\/Users\/[^\s]*?\/(src|infra)\//g, "").trim().slice(0, 300);
}

async function measureOne(p: { lexicon: "aws" | "k8s"; file: string; source: string; license: string }, workRoot: string): Promise<Entry> {
  const name = basename(p.file).replace(/[^A-Za-z0-9_.-]/g, "_");
  const dir = join(workRoot, `${p.lexicon}-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const inputName = `input${p.file.endsWith(".json") ? ".json" : ".yaml"}`;
  const input = join(dir, inputName);
  copyFileSync(join(fixtureRoot, p.file), input);
  const original = readFileSync(input, "utf-8");
  writeFileSync(
    join(dir, "chant.config.ts"),
    `export default { lexicons: ["${p.lexicon}"], telemetry: { attribution: false } };\n`,
  );
  const base = {
    file: p.file,
    lexicon: p.lexicon,
    source: p.source,
    license: p.license,
    sourceHasComments: /^\s*#/m.test(original) && !p.file.endsWith(".json"),
    differences: [] as Difference[],
    importWarnings: [] as string[],
  };
  const imp = await chant(dir, ["import", inputName, "--lexicon", p.lexicon, "-o", "src", "--force"]);
  const warnings = imp.out.split("\n").filter((l) => /^warning:/.test(l.trim())).map((l) => l.trim().replace(/^warning:\s*/, ""));
  if (!imp.ok) return { ...base, status: "import-failed", reasons: [failureClass(firstError(imp.out))], detail: firstError(imp.out), importWarnings: warnings };
  const outName = p.lexicon === "aws" ? "out.json" : "out.yaml";
  const build = await chant(dir, ["build", "src", "-o", outName]);
  const outPath = join(dir, outName);
  if (!build.ok || !existsSync(outPath)) {
    return { ...base, status: "build-failed", reasons: [failureClass(firstError(build.out))], detail: firstError(build.out), importWarnings: warnings };
  }
  const rebuilt = readFileSync(outPath, "utf-8");
  let canonA: string;
  let canonB: string;
  try {
    canonA = canonicalText(original, p.lexicon);
    canonB = canonicalText(rebuilt, p.lexicon);
  } catch (e) {
    return { ...base, status: "build-failed", reasons: ["output did not parse"], detail: String((e as Error).message).slice(0, 300), importWarnings: warnings };
  }
  if (canonA === canonB) return { ...base, status: "identical", reasons: [], importWarnings: warnings };
  const differences = diffCanonical(original, rebuilt, p.lexicon);
  const reasons = [...new Set(differences.map((d) => d.reason))].sort();
  return { ...base, status: "different", reasons, differences, importWarnings: warnings };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

// --- report ----------------------------------------------------------------

export function summarise(entries: Entry[]) {
  const per: Record<string, any> = {};
  for (const lex of ["aws", "k8s"] as const) {
    const es = entries.filter((e) => e.lexicon === lex);
    const reasonCounts: Record<string, number> = {};
    const failureCounts: Record<string, number> = {};
    const reasonScopes: Record<string, Set<string>> = {};
    for (const e of es) {
      if (e.status === "different") {
        for (const r of new Set(e.reasons as string[])) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
        for (const d of e.differences) {
          const scope = lex === "aws" ? d.path.split(/[.[]/)[0] : "";
          (reasonScopes[d.reason] ??= new Set()).add(scope);
        }
      } else if (e.status !== "identical") {
        const r = String(e.reasons[0]);
        failureCounts[r] = (failureCounts[r] ?? 0) + 1;
      }
    }
    per[lex] = {
      inputs: es.length,
      identical: es.filter((e) => e.status === "identical").length,
      different: es.filter((e) => e.status === "different").length,
      importFailed: es.filter((e) => e.status === "import-failed").length,
      buildFailed: es.filter((e) => e.status === "build-failed").length,
      reasonCounts,
      reasonScopes: Object.fromEntries(Object.entries(reasonScopes).map(([k, v]) => [k, [...v].filter(Boolean).sort()])),
      failureCounts,
    };
  }
  return per;
}

function markdown(meta: any, entries: Entry[]): string {
  const s = summarise(entries);
  const lines: string[] = [];
  lines.push("# Import round trip, byte level", "");
  lines.push(`Measured ${meta.date} at chant ${meta.chantVersion} (${meta.commit}).`, "");
  lines.push("| Target | Inputs | Byte-identical | Differ | Import failed | Build failed |", "|---|---|---|---|---|---|");
  for (const lex of ["aws", "k8s"]) {
    const x = s[lex];
    lines.push(`| ${lex === "aws" ? "CloudFormation" : "Kubernetes"} | ${x.inputs} | ${x.identical} | ${x.different} | ${x.importFailed} | ${x.buildFailed} |`);
  }
  lines.push("", "## Per input", "", "| Input | Result | Reasons |", "|---|---|---|");
  for (const e of entries) {
    const res = e.status;
    const why = e.status === "identical" ? "" : e.status === "different" ? (e.reasons as string[]).join(", ") : String(e.detail ?? "").replace(/\|/g, "\\|");
    lines.push(`| ${e.file} | ${res} | ${why} |`);
    if (e.status === "import-failed" || e.status === "build-failed") lines[lines.length - 1] = `| ${e.file} | ${res} | ${String(e.reasons[0])}: ${String(e.detail ?? "").replace(/\|/g, "\\|")} |`;
  }
  lines.push("", "## Reasons an input differs", "", "| Target | Reason | Where | Inputs affected |", "|---|---|---|---|");
  for (const lex of ["aws", "k8s"]) {
    for (const [r, n] of Object.entries(s[lex].reasonCounts).sort((a: any, b: any) => b[1] - a[1])) lines.push(`| ${lex} | ${r} | ${(s[lex].reasonScopes[r] ?? []).join(", ")} | ${n} |`);
  }
  lines.push("", "## Reasons an input does not complete", "", "| Target | Reason | Inputs affected |", "|---|---|---|");
  for (const lex of ["aws", "k8s"]) {
    for (const [r, n] of Object.entries(s[lex].failureCounts).sort((a: any, b: any) => b[1] - a[1])) lines.push(`| ${lex} | ${r} | ${n} |`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
  const write = !args.includes("--no-write");
  const prov = JSON.parse(readFileSync(join(fixtureRoot, "provenance.json"), "utf-8")) as any[];
  const todo = prov.filter((p) => !only || p.lexicon === only);
  const workRoot = join(root, ".import-roundtrip-tmp");
  mkdirSync(workRoot, { recursive: true });
  try {
    const entries = await pool(todo, 4, (p) => measureOne(p, workRoot));
    const pkg = JSON.parse(readFileSync(join(root, "packages", "core", "package.json"), "utf-8"));
    const { stdout } = await exec("git", ["rev-parse", "--short=9", "HEAD"], { cwd: root });
    const meta = { date: new Date().toISOString().slice(0, 10), chantVersion: pkg.version, commit: stdout.trim() };
    const result = { ...meta, summary: summarise(entries), entries };
    if (write && !only) {
      writeFileSync(join(fixtureRoot, "results.json"), JSON.stringify(result, null, 2) + "\n");
      writeFileSync(join(fixtureRoot, "results.md"), markdown(meta, entries));
    }
    console.log(markdown(meta, entries));
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
