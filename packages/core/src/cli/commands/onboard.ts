import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { formatSuccess, formatError, formatWarning } from "../format";

export interface OnboardOptions {
  name: string;
  verbose?: boolean;
}

export interface OnboardResult {
  success: boolean;
  patched: string[];
  skipped: string[];
  error?: string;
}

/** Resolve the monorepo root (5 dirs up from packages/core/src/cli/commands/). */
function findRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // commands/
  return dirname(dirname(dirname(dirname(dirname(here))))); // -> root
}

/**
 * Patch root package.json to add a workspace dependency for the lexicon.
 */
function patchRootPackageJson(root: string, name: string): { patched: boolean; reason?: string } {
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
 * Insert a new prepack line after the last prepack line in each contiguous group
 * of 2+ lines. Single standalone lines (like YAML `run:` values) are ignored.
 * Used for multi-line `run: |` blocks in workflows and Dockerfile RUN sequences.
 */
function insertPrepackInContiguousGroups(lines: string[], name: string): boolean {
  const newFragment = `lexicons/${name} prepack`;
  if (lines.some((l) => l.includes(newFragment))) return false;

  // Identify contiguous groups of prepack lines
  const groups: { start: number; end: number }[] = [];
  let groupStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isPrepack =
      i < lines.length &&
      lines[i].includes("bun run --cwd lexicons/") &&
      lines[i].includes("prepack");
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
 * Used for Dockerfiles and publish.yml where all occurrences should get a new line.
 */
function insertPrepackAfterEach(lines: string[], name: string): boolean {
  const newFragment = `lexicons/${name} prepack`;
  if (lines.some((l) => l.includes(newFragment))) return false;

  const insertAfter: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("bun run --cwd lexicons/") || !lines[i].includes("prepack")) continue;
    const nextIsAlsoPrepack =
      i + 1 < lines.length &&
      lines[i + 1].includes("bun run --cwd lexicons/") &&
      lines[i + 1].includes("prepack");
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
 * 1. Multi-line blocks (check + test jobs): `run: |\n  bun run --cwd lexicons/aws prepack\n  ...`
 * 2. Standalone steps (validate job): `- name: Generate and validate ...\n  run: bun run --cwd ...`
 *
 * We only insert into pattern 1 (contiguous groups) and separately add a new pattern 2 step.
 */
function patchCiWorkflow(root: string, name: string): { patched: boolean; reason?: string } {
  const filePath = join(root, ".github/workflows/chant.yml");
  if (!existsSync(filePath)) return { patched: false, reason: "chant.yml not found" };

  const content = readFileSync(filePath, "utf-8");
  if (content.includes(`lexicons/${name} prepack`)) {
    return { patched: false, reason: `${name} already in chant.yml` };
  }

  const lines = content.split("\n");

  // 1. Insert into multi-line `run: |` blocks only (contiguous prepack groups of 3+).
  //    The validate job has standalone steps that are NOT contiguous, so they won't match.
  insertPrepackInContiguousGroups(lines, name);

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
        `        run: bun run --cwd lexicons/${name} prepack`,
      ];
      lines.splice(lastValidateRunIdx + 1, 0, ...block);
    }
  }

  writeFileSync(filePath, lines.join("\n"));
  return { patched: true };
}

/**
 * Patch publish.yml: add prepack line in test job + publish step.
 */
function patchPublishWorkflow(root: string, name: string): { patched: boolean; reason?: string } {
  const filePath = join(root, ".github/workflows/publish.yml");
  if (!existsSync(filePath)) return { patched: false, reason: "publish.yml not found" };

  const content = readFileSync(filePath, "utf-8");
  if (content.includes(`working-directory: lexicons/${name}`)) {
    return { patched: false, reason: `publish step for ${name} already present` };
  }

  const lines = content.split("\n");

  // Insert prepack line in test job
  insertPrepackAfterEach(lines, name);

  // Add publish step after the last existing publish step
  let lastPublishRunIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("bun publish --access public --tolerate-republish")) {
      lastPublishRunIdx = i;
    }
  }

  if (lastPublishRunIdx > 0) {
    const block = [
      "",
      `      - name: Publish @intentius/chant-lexicon-${name}`,
      `        working-directory: lexicons/${name}`,
      "        run: bun publish --access public --tolerate-republish",
    ];
    lines.splice(lastPublishRunIdx + 1, 0, ...block);
  }

  writeFileSync(filePath, lines.join("\n"));
  return { patched: true };
}

/**
 * Patch a Dockerfile to add a prepack RUN line.
 */
function patchDockerfile(filePath: string, name: string): { patched: boolean; reason?: string } {
  if (!existsSync(filePath)) return { patched: false, reason: `${filePath} not found` };

  const content = readFileSync(filePath, "utf-8");
  if (content.includes(`lexicons/${name} prepack`)) {
    return { patched: false, reason: `prepack for ${name} already in Dockerfile` };
  }

  const lines = content.split("\n");
  insertPrepackAfterEach(lines, name);
  writeFileSync(filePath, lines.join("\n"));
  return { patched: true };
}

/**
 * Execute the onboard command — patches monorepo infrastructure for a new lexicon.
 */
export function onboardCommand(options: OnboardOptions): OnboardResult {
  const root = findRepoRoot();
  const patched: string[] = [];
  const skipped: string[] = [];

  // 1. Root package.json
  const pkgResult = patchRootPackageJson(root, options.name);
  if (pkgResult.patched) patched.push("package.json (root dependency)");
  else skipped.push(`package.json: ${pkgResult.reason}`);

  // 2. CI workflow
  const ciResult = patchCiWorkflow(root, options.name);
  if (ciResult.patched) patched.push("chant.yml (prepack + validate)");
  else skipped.push(`chant.yml: ${ciResult.reason}`);

  // 3. Publish workflow
  const pubResult = patchPublishWorkflow(root, options.name);
  if (pubResult.patched) patched.push("publish.yml (prepack + publish step)");
  else skipped.push(`publish.yml: ${pubResult.reason}`);

  // 4. Dockerfiles
  const dockerBun = join(root, "test/Dockerfile.smoke");
  const dockerNode = join(root, "test/Dockerfile.smoke-node");

  const db = patchDockerfile(dockerBun, options.name);
  if (db.patched) patched.push("Dockerfile.smoke (prepack)");
  else skipped.push(`Dockerfile.smoke: ${db.reason}`);

  const dn = patchDockerfile(dockerNode, options.name);
  if (dn.patched) patched.push("Dockerfile.smoke-node (prepack)");
  else skipped.push(`Dockerfile.smoke-node: ${dn.reason}`);

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
    console.log("Skipped (already configured):");
    for (const s of result.skipped) {
      console.log(`  ${s}`);
    }
  }

  console.log("");
  console.log("Remaining manual steps:");
  console.log(`  1. Create an example: lexicons/${name}/examples/<example-name>/`);
  console.log(`     (must depend on @intentius/chant-lexicon-${name} for workspace resolution)`);
  console.log(`  2. Add smoke tests to test/integration.sh`);
  console.log(`  3. Run: bun install (to update workspace links)`);
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
    const checkResult = checkLexicon(lexiconDir);
    printCheckResult(checkResult, false);
  }
}
