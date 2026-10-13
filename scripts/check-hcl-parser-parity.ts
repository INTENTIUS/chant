#!/usr/bin/env tsx
/**
 * Compare a candidate HCL parser against the one chant ships (chant #2483).
 *
 *   npx tsx scripts/check-hcl-parser-parity.ts --candidate @cdktn/hcl2json@0.24.0
 *   npx tsx scripts/check-hcl-parser-parity.ts --candidate /path/to/node_modules/@cdktn/hcl2json \
 *       --corpus ../choudoufu --record /tmp/hcl2json.jsonl
 *
 * `--candidate` is a package directory, or an npm spec that is installed
 * into a temporary prefix first. `--reference` defaults to the
 * `@cdktn/hcl2json` this checkout resolves. `--corpus` (repeatable) adds a
 * directory to walk; with none given, the lexicon fixtures, core's carve
 * fixtures and `examples/` are walked. `--record` (repeatable) replays a file
 * the test suite wrote under `CHANT_HCL2JSON_RECORD`:
 *
 *   CHANT_HCL2JSON_RECORD=/tmp/hcl2json.jsonl npx vitest run lexicons/terraform packages/core/src/terraform
 *
 * Each parser runs in its own process (they share a global). The human
 * report goes to stderr; `--json` writes the full report to stdout. Exit 1
 * when any tree, reference list or error differs, so a difference is a
 * measurement to file, never something to normalise away.
 *
 * The comparison itself is in `hcl-parser-parity.ts`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectCorpus,
  dedupeInputs,
  describePackage,
  formatReport,
  compareOutputs,
  readRecord,
  runWorker,
  type ParityInput,
  type ParityOutput,
} from "./hcl-parser-parity";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);

const DEFAULT_CORPUS = [
  "lexicons/terraform/src/__fixtures__",
  "packages/core/src/terraform/__fixtures__",
  "examples",
];

interface Args {
  candidate?: string;
  reference?: string;
  corpus: string[];
  record: string[];
  json: boolean;
  show: number;
  worker?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { corpus: [], record: [], json: false, show: 10 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--candidate":
        args.candidate = value();
        break;
      case "--reference":
        args.reference = value();
        break;
      case "--corpus":
        args.corpus.push(value());
        break;
      case "--record":
        args.record.push(value());
        break;
      case "--json":
        args.json = true;
        break;
      case "--show":
        args.show = Number(value());
        break;
      case "--worker":
        args.worker = value();
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  return args;
}

/** The directory of the package `spec` names: a directory as given, else an npm install into a fresh prefix. */
function resolveCandidate(spec: string): string {
  if (existsSync(join(spec, "package.json"))) return resolve(spec);
  const prefix = mkdtempSync(join(tmpdir(), "chant-hcl-parity-"));
  console.error(`  installing ${spec} into ${prefix}`);
  const install = spawnSync("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--no-package-lock", spec], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (install.status !== 0) throw new Error(`npm install ${spec} failed`);
  const name = spec.startsWith("@") ? spec.slice(0, spec.indexOf("@", 1) === -1 ? undefined : spec.indexOf("@", 1)) : spec.split("@")[0];
  const dir = join(prefix, "node_modules", name);
  if (!existsSync(join(dir, "package.json"))) throw new Error(`installed ${spec} but found no package at ${dir}`);
  return dir;
}

function resolveReference(given: string | undefined): string {
  if (given) return resolve(given);
  const require = createRequire(join(repoRoot, "package.json"));
  return dirname(require.resolve("@cdktn/hcl2json/package.json"));
}

/** Run one parser in a child process and read its outputs back. */
function runIsolated(packageDir: string, inputs: readonly ParityInput[]): ParityOutput[] {
  const child = spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--worker", packageDir], {
    input: JSON.stringify(inputs),
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 1024,
    cwd: repoRoot,
  });
  if (child.status !== 0) throw new Error(`worker for ${packageDir} failed:\n${child.stderr}`);
  return JSON.parse(child.stdout) as ParityOutput[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.worker) {
    const inputs = JSON.parse(readFileSync(0, "utf-8")) as ParityInput[];
    process.stdout.write(JSON.stringify(await runWorker(args.worker, inputs)));
    return;
  }

  if (!args.candidate) throw new Error("--candidate <package dir | npm spec> is required");
  const reference = resolveReference(args.reference);
  const candidate = resolveCandidate(args.candidate);

  const corpusRoots = (args.corpus.length > 0 ? args.corpus : DEFAULT_CORPUS).map((c) => resolve(repoRoot, c));
  const collected = collectCorpus(corpusRoots, process.cwd());
  const recorded = args.record.flatMap((path) => readRecord(readFileSync(path, "utf-8"), path));
  const inputs = dedupeInputs([...collected, ...recorded]);
  const labels = new Map(inputs.map((i) => [i.id, i.label]));
  console.error(
    `  reference ${describePackage(reference)}\n  candidate ${describePackage(candidate)}\n  inputs    ${inputs.length} (${collected.length} corpus files, ${recorded.length} recorded calls, deduplicated)`,
  );

  const referenceOut = runIsolated(reference, inputs);
  const candidateOut = runIsolated(candidate, inputs);
  const report = compareOutputs(referenceOut, candidateOut);

  console.error(formatReport(report, { show: args.show, labels }));
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ reference: describePackage(reference), candidate: describePackage(candidate), inputs: inputs.length, ...report }, null, 2)}\n`,
    );
  }
  process.exitCode = report.differences.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
