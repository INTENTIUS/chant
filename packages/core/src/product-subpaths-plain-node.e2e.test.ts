/**
 * The products import the installed, pinned chant at run time (chant#4591).
 * plywood and terragucci mark `@intentius/chant*` external in their CLI
 * bundles, so every subpath they load must resolve, under plain Node and no
 * TypeScript loader, to compiled JS. Node does not strip types under
 * node_modules, so the core exports carry an `import` condition on `dist/*.js`
 * beside `development` and `default`, as `./notify` did first (#3803).
 *
 * This packs core and the terraform lexicon the way a release does (each
 * prepack builds dist/), unpacks both into a scratch project's node_modules,
 * links the rest of the repository's installed dependencies beside them, and
 * imports each subpath with `node` and nothing else. A compiled lexicon
 * imports core too, so the lexicon rows also prove core's root and subpaths
 * reach dist/.
 *
 * End to end because `npm pack` runs both package builds.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { transformSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const coreRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(coreRoot, "..", "..");
const terraformRoot = join(repoRoot, "lexicons", "terraform");

/**
 * Every `@intentius/chant` subpath plywood or terragucci loads at run time
 * (type-only imports left out), from packages/plywood/src and
 * packages/terragucci/src at integration/ci-products, plus the ones chant#4591
 * names. A product that starts importing another one adds it here.
 */
const CORE_SUBPATHS = [
  "",
  "bucket-check",
  "change-set",
  "ci-control",
  "ci-handover",
  "ci-identity",
  "ci-product",
  "components",
  "components/capability",
  "components/check-hooks",
  "components/component",
  "components/pr-env-run",
  "components/pr-environment",
  "components/verbs/sign",
  "exit-codes",
  "forge-check",
  "gate-decision",
  "gate-policy",
  "gate-resume-run",
  "gated-waves",
  "lifecycle/gate-audit",
  "lifecycle/git",
  "lifecycle/ledger-read",
  "lifecycle/plan-digest",
  "lifecycle/query",
  "lifecycle/release-ledger",
  "lifecycle/target-lock",
  "lint/post-synth",
  "notify",
  "object-store",
  "op",
  "op/activities",
  "op/activities/review-agent",
  "op/gate-resume-plan",
  "op/op-waves",
  "op/schedule-overdue",
  "op/stage-hooks",
  "override-gate",
  "plan-summary",
  "point-decision",
  "pr-forge",
  "pr-requires",
  "read-filter",
  "terraform/credentials",
  "terraform/parse",
  "wave-blocked",
  "workspace/ci-branches",
  "workspace/declaration",
  "workspace/which-chant",
  "yaml",
] as const;

/** The terraform lexicon subpaths the products load (and chant#4591 names). */
const TERRAFORM_SUBPATHS = [
  "change-set",
  "changed-roots",
  "compose",
  "compose/estate",
  "compose/root",
  "compose/run",
  "compose/slice",
  "config",
  "drift-rows",
  "hcl/parse",
  "lint/post-synth/tf046",
  "pin",
  "plan-digest",
  "plan-shape",
  "registry",
  "registry/edge",
  "state",
  "terragrunt/affected",
  "terragrunt/mocks",
  "terragrunt/run",
  "terragrunt/units",
  "terragrunt/wave",
] as const;

let scratch: string;
let consumer: string;

/** Packs `dir` into `scratch` and unpacks it at `consumer/node_modules/<name>`. */
function packInto(dir: string, name: string): void {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }),
  ) as { filename: string }[];
  const into = join(consumer, "node_modules", name);
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", join(scratch, packed[0].filename), "-C", into, "--strip-components=1"]);
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "chant-product-subpaths-"));
  consumer = join(scratch, "consumer");
  mkdirSync(join(consumer, "node_modules", "@intentius"), { recursive: true });
  packInto(coreRoot, "@intentius/chant");
  packInto(terraformRoot, "@intentius/chant-lexicon-terraform");
  // Third-party dependencies come from the repository's install: the
  // hoisted ones beside the packages, core's nested ones under core.
  for (const name of readdirSync(join(repoRoot, "node_modules"))) {
    if (name === "@intentius" || name.startsWith(".")) continue;
    symlinkSync(join(repoRoot, "node_modules", name), join(consumer, "node_modules", name), "dir");
  }
  symlinkSync(join(coreRoot, "node_modules"), join(consumer, "node_modules", "@intentius", "chant", "node_modules"), "dir");
}, 900_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Imports each specifier under plain node in the consumer project, with no loader. */
function importEach(specifiers: readonly string[]): { specifier: string; from?: string; exports?: number; error?: string }[] {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const source = `
    const out = [];
    for (const specifier of ${JSON.stringify(specifiers)}) {
      try {
        const m = await import(specifier);
        out.push({ specifier, from: import.meta.resolve(specifier), exports: Object.keys(m).length });
      } catch (e) {
        out.push({ specifier, error: String(e?.message ?? e).split("\\n")[0] });
      }
    }
    console.log(JSON.stringify(out));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], { cwd: consumer, env, encoding: "utf-8" }));
}

/** Every .js and .mjs file under `dir`. */
function compiledFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : compiledFiles(path);
    return /\.m?js$/.test(name) ? [path] : [];
  });
}

describe("product subpaths under plain Node (chant#4591)", () => {
  test("every compiled module in both tarballs parses", () => {
    // A product's bundler parses every module an import reaches, dynamic ones
    // too. tsc-alias once rewrote a regex shaped like an import and left a
    // file Node could not parse (chud-lexicon-exit.js).
    const unparsed: string[] = [];
    for (const pkg of ["@intentius/chant", "@intentius/chant-lexicon-terraform"]) {
      for (const file of compiledFiles(join(consumer, "node_modules", pkg, "dist"))) {
        try {
          transformSync(readFileSync(file, "utf-8"), { format: "esm", loader: "js", logLevel: "silent" });
        } catch (e) {
          unparsed.push(`${file}: ${(e as { errors?: { text: string }[] }).errors?.[0]?.text ?? String(e)}`);
        }
      }
    }
    expect(unparsed).toEqual([]);
  });


  test("every core subpath a product loads imports from dist/", () => {
    const results = importEach(CORE_SUBPATHS.map((s) => (s ? `@intentius/chant/${s}` : "@intentius/chant")));
    expect(results.filter((r) => r.error)).toEqual([]);
    for (const r of results) {
      expect(r.from, r.specifier).toMatch(/\/node_modules\/@intentius\/chant\/dist\/.+\.js$/);
      expect(r.exports, r.specifier).toBeGreaterThan(0);
    }
  });

  test("every terraform lexicon subpath a product loads imports from dist/, with core from dist/ under it", () => {
    const results = importEach(TERRAFORM_SUBPATHS.map((s) => `@intentius/chant-lexicon-terraform/${s}`));
    expect(results.filter((r) => r.error)).toEqual([]);
    for (const r of results) {
      expect(r.from, r.specifier).toMatch(/\/node_modules\/@intentius\/chant-lexicon-terraform\/dist\/.+\.js$/);
    }
  });
});
