import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { formatSuccess, formatError, formatWarning } from "../format";

export interface OnboardOptions {
  name: string;
  verbose?: boolean;
  /** Monorepo root to patch. Defaults to the root this module lives in. */
  root?: string;
}

export interface OnboardResult {
  success: boolean;
  patched: string[];
  skipped: string[];
  error?: string;
}

export interface PatchResult {
  patched: boolean;
  reason?: string;
}

/** Resolve the monorepo root (5 dirs up from packages/core/src/cli/commands/). */
function findRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // commands/
  return dirname(dirname(dirname(dirname(dirname(here))))); // -> root
}

/**
 * A real prepack invocation line: a Dockerfile `RUN`, a workflow `- run:`,
 * or a bare line inside a `run: |` block. Comments, `echo` messages and
 * `$lex` / `<lex>` placeholders do not match. Matching those placeholder
 * substrings was how onboard appended duplicates to Dockerfile.smoke on
 * every run (#1678).
 */
const PREPACK_LINE = /^\s*(?:RUN\s+|-\s*run:\s*)?npm run --prefix lexicons\/[a-z0-9-]+ prepack\s*$/i;

function isPrepackLine(line: string): boolean {
  return PREPACK_LINE.test(line);
}

function hasPrepackLine(lines: string[], name: string): boolean {
  return lines.some((l) => isPrepackLine(l) && l.includes(`lexicons/${name} prepack`));
}

/** Shell loop header over lexicon names: `for lex in aws gcp k8s; do \`. */
const LEX_LOOP = /^(\s*(?:RUN\s+)?for lex in )([a-z0-9][a-z0-9 -]*?)(\s*;\s*do\b.*)$/i;

function loopCoversLexicon(lines: string[], name: string): boolean {
  return lines.some((l) => {
    const m = l.match(LEX_LOOP);
    return m !== null && m[2].split(/\s+/).includes(name);
  });
}

/**
 * Append the lexicon to every `for lex in ...` loop list that does not
 * already contain it. Returns true when at least one list changed.
 */
function addToLexiconLoops(lines: string[], name: string): boolean {
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LEX_LOOP);
    if (!m) continue;
    const names = m[2].split(/\s+/).filter(Boolean);
    if (names.includes(name)) continue;
    names.push(name);
    lines[i] = `${m[1]}${names.join(" ")}${m[3]}`;
    changed = true;
  }
  return changed;
}

/**
 * Patch root package.json to add a workspace dependency for the lexicon.
 */
function patchRootPackageJson(root: string, name: string): PatchResult {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return { patched: false, reason: "root package.json not found" };

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const depKey = `@intentius/chant-lexicon-${name}`;

  if (pkg.dependencies?.[depKey]) {
    return { patched: false, reason: `${depKey} already in dependencies` };
  }

  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies[depKey] = "workspace:*";

  // Sort dependencies for consistency
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(pkg.dependencies).sort()) {
    sorted[k] = pkg.dependencies[k];
  }
  pkg.dependencies = sorted;

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return { patched: true };
}

/**
 * Patch the root tsconfig.json `paths` map (#1614).
 *
 * The whole-repo typecheck runs with `moduleResolution: node`, which never
 * reads package exports maps, so every lexicon needs a bare + subpath
 * mapping here or an example importing the package fails to resolve.
 */
export function patchRootTsconfigPaths(root: string, name: string): PatchResult {
  const tsconfigPath = join(root, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return { patched: false, reason: "root tsconfig.json not found" };

  const cfg = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
  cfg.compilerOptions = cfg.compilerOptions ?? {};
  const paths: Record<string, string[]> = (cfg.compilerOptions.paths = cfg.compilerOptions.paths ?? {});

  const bare = `@intentius/chant-lexicon-${name}`;
  const wanted: Record<string, string[]> = {
    [bare]: [`lexicons/${name}/src/index.ts`],
    [`${bare}/*`]: [`lexicons/${name}/src/*`],
  };

  let changed = false;
  for (const [key, value] of Object.entries(wanted)) {
    if (Array.isArray(paths[key]) && paths[key].length > 0) continue;
    paths[key] = value;
    changed = true;
  }

  if (!changed) return { patched: false, reason: `${bare} already in paths` };

  writeFileSync(tsconfigPath, JSON.stringify(cfg, null, 2) + "\n");
  return { patched: true };
}

/**
 * Insert a new prepack line after the last prepack line in each contiguous group
 * of 2+ lines. Single standalone lines (like YAML `run:` values) are ignored.
 * Used for multi-line `run: |` blocks in workflows.
 */
function insertPrepackInContiguousGroups(lines: string[], name: string): boolean {
  if (hasPrepackLine(lines, name)) return false;

  // Identify contiguous groups of prepack lines
  const groups: { start: number; end: number }[] = [];
  let groupStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isPrepack = i < lines.length && isPrepackLine(lines[i]);
    if (isPrepack && groupStart === -1) {
      groupStart = i;
    } else if (!isPrepack && groupStart !== -1) {
      groups.push({ start: groupStart, end: i - 1 });
      groupStart = -1;
    }
  }

  // Only insert into groups of 2+ lines (multi-line blocks, not standalone steps)
  const insertAfter = groups.filter((g) => g.end > g.start).map((g) => g.end);

  if (insertAfter.length === 0) return false;

  for (const idx of insertAfter.reverse()) {
    const newLine = lines[idx].replace(/lexicons\/[a-z0-9-]+/i, `lexicons/${name}`);
    lines.splice(idx + 1, 0, newLine);
  }

  return true;
}

/**
 * Insert a new prepack line after every last-in-group prepack line (groups of 1+).
 * Used for publish.yml and Dockerfiles that list one RUN per lexicon.
 */
export function insertPrepackAfterEach(lines: string[], name: string): boolean {
  if (hasPrepackLine(lines, name)) return false;

  const insertAfter: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isPrepackLine(lines[i])) continue;
    const nextIsAlsoPrepack = i + 1 < lines.length && isPrepackLine(lines[i + 1]);
    if (!nextIsAlsoPrepack) {
      insertAfter.push(i);
    }
  }

  if (insertAfter.length === 0) return false;

  for (const idx of insertAfter.reverse()) {
    const newLine = lines[idx].replace(/lexicons\/[a-z0-9-]+/i, `lexicons/${name}`);
    lines.splice(idx + 1, 0, newLine);
  }

  return true;
}

/**
 * Patch chant.yml: add prepack lines in check/test multi-line `run: |` blocks,
 * and add a new validate step.
 *
 * The file has two patterns:
 * 1. Multi-line blocks (check + test jobs): `run: |\n  npm run --prefix lexicons/aws prepack\n  ...`
 * 2. Standalone steps (validate job): `- name: Generate and validate ...\n  run: npm run --prefix ...`
 *
 * We only insert into pattern 1 (contiguous groups) and separately add a new pattern 2 step.
 */
function patchCiWorkflow(root: string, name: string): PatchResult {
  const filePath = join(root, ".github/workflows/chant.yml");
  if (!existsSync(filePath)) return { patched: false, reason: "chant.yml not found" };

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  if (hasPrepackLine(lines, name)) {
    return { patched: false, reason: `${name} already in chant.yml` };
  }

  // 1. Insert into multi-line `run: |` blocks only (contiguous prepack groups of 2+).
  //    The validate job has standalone steps that are NOT contiguous, so they won't match.
  let changed = insertPrepackInContiguousGroups(lines, name);

  // 2. Add a named validate step after the last "Generate and validate" step
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  const validateStepName = `Generate and validate ${displayName} lexicon`;

  if (!lines.some((l) => l.includes(validateStepName))) {
    let lastValidateRunIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("Generate and validate")) {
        if (i + 1 < lines.length && lines[i + 1].trimStart().startsWith("run:")) {
          lastValidateRunIdx = i + 1;
        }
      }
    }

    if (lastValidateRunIdx > 0) {
      const block = [
        "",
        `      - name: ${validateStepName}`,
        `        run: npm run --prefix lexicons/${name} prepack`,
      ];
      lines.splice(lastValidateRunIdx + 1, 0, ...block);
      changed = true;
    }
  }

  if (!changed) return { patched: false, reason: "no prepack block found to anchor on" };
  writeFileSync(filePath, lines.join("\n"));
  return { patched: true };
}

/**
 * Patch publish.yml: add the prepack line to the test job.
 *
 * No publish step is added. scripts/publish-packages.sh enumerates every
 * non-private workspace package at run time, so a new lexicon is published
 * the moment it exists — that is deliberate. Hand-maintained publish steps
 * were how k8s-client (#1177) and fountain (#1253) each shipped a package
 * the release pipeline could not publish.
 */
function patchPublishWorkflow(root: string, name: string): PatchResult {
  const filePath = join(root, ".github/workflows/publish.yml");
  if (!existsSync(filePath)) return { patched: false, reason: "publish.yml not found" };

  const lines = readFileSync(filePath, "utf-8").split("\n");
  if (hasPrepackLine(lines, name)) {
    return { patched: false, reason: `prepack for ${name} already present` };
  }

  if (!insertPrepackAfterEach(lines, name)) {
    return { patched: false, reason: "no prepack line found to anchor on" };
  }
  writeFileSync(filePath, lines.join("\n"));
  return { patched: true };
}

/**
 * Patch a smoke Dockerfile so it covers the lexicon.
 *
 * Two layouts exist. Loop-based files (`for lex in aws gcp ...; do`) get the
 * name appended to every loop list. Per-lexicon files (`RUN npm run --prefix
 * lexicons/<x> prepack` lines) get one more RUN line. A file that already
 * covers the lexicon either way is reported as such and left untouched.
 */
export function patchDockerfile(filePath: string, name: string): PatchResult {
  if (!existsSync(filePath)) return { patched: false, reason: `${filePath} not found` };

  const lines = readFileSync(filePath, "utf-8").split("\n");
  if (loopCoversLexicon(lines, name) || hasPrepackLine(lines, name)) {
    return { patched: false, reason: `already covers ${name}` };
  }

  const changed = addToLexiconLoops(lines, name) || insertPrepackAfterEach(lines, name);
  if (!changed) {
    return { patched: false, reason: "no lexicon loop or prepack line found to anchor on" };
  }

  writeFileSync(filePath, lines.join("\n"));
  return { patched: true };
}

/**
 * Execute the onboard command — patches monorepo infrastructure for a new lexicon.
 */
export function onboardCommand(options: OnboardOptions): OnboardResult {
  const root = options.root ?? findRepoRoot();
  const patched: string[] = [];
  const skipped: string[] = [];

  const record = (label: string, summary: string, result: PatchResult) => {
    if (result.patched) patched.push(`${label} (${summary})`);
    else skipped.push(`${label}: ${result.reason}`);
  };

  // 1. Root package.json
  record("package.json", "root dependency", patchRootPackageJson(root, options.name));

  // 2. Root tsconfig.json paths (#1614)
  record("tsconfig.json", "paths mapping", patchRootTsconfigPaths(root, options.name));

  // 3. CI workflow
  record("chant.yml", "prepack + validate", patchCiWorkflow(root, options.name));

  // 4. Publish workflow
  record("publish.yml", "prepack", patchPublishWorkflow(root, options.name));

  // 5. Dockerfiles
  record("Dockerfile.smoke", "lexicon list", patchDockerfile(join(root, "test/Dockerfile.smoke"), options.name));
  record(
    "Dockerfile.smoke-npm",
    "lexicon list",
    patchDockerfile(join(root, "test/Dockerfile.smoke-npm"), options.name),
  );

  return { success: true, patched, skipped };
}

/**
 * Print onboard results and remaining manual steps.
 */
export async function printOnboardResult(result: OnboardResult, name: string): Promise<void> {
  if (!result.success) {
    console.error(formatError({ message: result.error ?? "onboard failed" }));
    return;
  }

  if (result.patched.length > 0) {
    console.log(formatSuccess("Patched:"));
    for (const f of result.patched) {
      console.log(`  ${f}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log("");
    console.log("Skipped (already covered):");
    for (const s of result.skipped) {
      console.log(`  ${s}`);
    }
  }

  console.log("");
  console.log("Remaining manual steps:");
  console.log(`  1. Create an example: lexicons/${name}/examples/<example-name>/`);
  console.log(`     (must depend on @intentius/chant-lexicon-${name} for workspace resolution)`);
  console.log(`  2. Add smoke tests to test/integration.sh`);
  console.log(`  3. Run: npm install (to update workspace links)`);
  console.log(`  4. First npm publish: tag with v<version> and push`);
  console.log(`  5. Run: chant dev check-lexicon lexicons/${name} (to see completeness status)`);
  console.log(formatWarning({
    message: "First-time scoped packages may publish as private despite --access public",
  }));
  console.log(`     Check https://www.npmjs.com/org/intentius and toggle visibility if needed`);

  // Run check-lexicon if the lexicon directory exists
  const lexiconDir = join(findRepoRoot(), "lexicons", name);
  if (existsSync(lexiconDir)) {
    console.log("");
    console.log("Lexicon completeness:");
    const { checkLexicon, printCheckResult } = await import("./check-lexicon");
    const checkResult = await checkLexicon(lexiconDir);
    printCheckResult(checkResult, false);
  }
}
