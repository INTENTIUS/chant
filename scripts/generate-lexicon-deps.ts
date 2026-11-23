#!/usr/bin/env tsx
/**
 * Generate the workspace lexicons a lexicon builds against (#5515).
 *
 *   npx tsx scripts/generate-lexicon-deps.ts <lexicon>          run each one's generate
 *   npx tsx scripts/generate-lexicon-deps.ts <lexicon> --list   print them, one per line
 *
 * A lexicon's build compiles the lexicons it imports from their source (its
 * tsconfig.build.json sets the `@intentius/chant-source` condition), so their
 * `src/generated` barrels must exist first. k8s imports otel and prometheus,
 * and otel imports sql. The lexicon-upgrade workflow runs only `npm install`,
 * so without this the upgrade's regen fails its build step on
 * `Cannot find module '../generated/index'` and never opens a pull request.
 *
 * The dependencies are every `@intentius/chant-lexicon-<name>` in the
 * lexicon's dependencies, devDependencies or peerDependencies that is a
 * directory under lexicons/, followed transitively and ordered so a
 * dependency comes before the lexicons that import it (`just regen` orders
 * generate the same way, #1133). The lexicon itself is left out: the upgrade
 * generates it. A dependency with no `generate` script is skipped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PREFIX = "@intentius/chant-lexicon-";

interface LexiconPackage {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readPackage(root: string, lexicon: string): LexiconPackage | null {
  const path = join(root, "lexicons", lexicon, "package.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as LexiconPackage) : null;
}

/** The workspace lexicons `pkg` names directly, sorted. */
function directDependencies(root: string, pkg: LexiconPackage): string[] {
  const names = new Set<string>();
  for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
    for (const name of Object.keys(deps ?? {})) {
      if (!name.startsWith(PREFIX)) continue;
      const lexicon = name.slice(PREFIX.length);
      if (existsSync(join(root, "lexicons", lexicon, "package.json"))) names.add(lexicon);
    }
  }
  return [...names].sort();
}

/**
 * The workspace lexicons `lexicon` builds against, transitively, each after
 * the ones it imports. Excludes `lexicon` itself.
 */
export function lexiconDependencies(root: string, lexicon: string): string[] {
  if (!readPackage(root, lexicon)) throw new Error(`no lexicons/${lexicon}/package.json under ${root}`);
  const ordered: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`lexicon dependency cycle through ${name}`);
    visiting.add(name);
    for (const dep of directDependencies(root, readPackage(root, name) ?? {})) visit(dep);
    visiting.delete(name);
    done.add(name);
    ordered.push(name);
  };
  visit(lexicon);
  return ordered.filter((name) => name !== lexicon);
}

/** The dependencies of `lexicon` that have a `generate` script, in order. */
export function lexiconsToGenerate(root: string, lexicon: string): string[] {
  return lexiconDependencies(root, lexicon).filter((name) => readPackage(root, name)?.scripts?.generate);
}

function main(argv: string[]): void {
  const [lexicon, flag] = argv;
  if (!lexicon || (flag !== undefined && flag !== "--list")) {
    process.stderr.write("usage: generate-lexicon-deps.ts <lexicon> [--list]\n");
    process.exit(2);
  }
  const root = resolve(import.meta.dirname, "..");
  const names = lexiconsToGenerate(root, lexicon);
  if (flag === "--list") {
    for (const name of names) process.stdout.write(`${name}\n`);
    return;
  }
  if (names.length === 0) {
    process.stdout.write(`${lexicon} builds against no other workspace lexicon\n`);
    return;
  }
  for (const name of names) {
    process.stdout.write(`generate: ${name}\n`);
    execFileSync("npm", ["run", "--prefix", join(root, "lexicons", name), "generate"], { stdio: "inherit" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main(process.argv.slice(2));
