import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";

// ── Types ────────────────────────────────────────────────────────────

export interface CheckItem {
  name: string;
  tier: 1 | 2 | 3;
  pass: boolean;
  detail?: string;
}

export interface CheckResult {
  items: CheckItem[];
  tier1Pass: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** List .ts files in a directory, optionally excluding some basenames. */
function listTsFiles(dir: string, exclude: string[] = []): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !exclude.includes(f));
}

/** Recursively find files matching a predicate. */
function findFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      results.push(...findFiles(join(dir, entry.name), predicate));
    } else if (predicate(entry.name)) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

/** Read a file's content, returning empty string if missing. */
function readOr(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Count subdirectories in a directory, ignoring .gitkeep-only dirs. */
function countSubdirs(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => {
      const contents = readdirSync(join(dir, e.name));
      // Ignore directories that only contain .gitkeep
      return contents.length > 0 && !(contents.length === 1 && contents[0] === ".gitkeep");
    })
    .length;
}

// ── Check runner ─────────────────────────────────────────────────────

/**
 * Run all completeness checks against a lexicon directory.
 */
export function checkLexicon(dir: string): CheckResult {
  const items: CheckItem[] = [];

  // ── Tier 1: Required ───────────────────────────────────────────

  items.push({
    name: "src/plugin.ts exists",
    tier: 1,
    pass: existsSync(join(dir, "src/plugin.ts")),
  });

  items.push({
    name: "src/serializer.ts exists",
    tier: 1,
    pass: existsSync(join(dir, "src/serializer.ts")),
  });

  const ruleFiles = listTsFiles(join(dir, "src/lint/rules"), ["index.ts"]);
  items.push({
    name: "At least 1 lint rule in src/lint/rules/",
    tier: 1,
    pass: ruleFiles.length > 0,
    detail: ruleFiles.length > 0 ? `${ruleFiles.length} rule(s)` : undefined,
  });

  const postSynthFiles = listTsFiles(join(dir, "src/lint/post-synth"), ["index.ts", "helpers.ts"]);
  items.push({
    name: "At least 1 post-synth check",
    tier: 1,
    pass: postSynthFiles.length > 0,
    detail: postSynthFiles.length > 0 ? `${postSynthFiles.length} check(s)` : undefined,
  });

  items.push({
    name: "src/lsp/completions.ts exists",
    tier: 1,
    pass: existsSync(join(dir, "src/lsp/completions.ts")),
  });

  items.push({
    name: "src/lsp/hover.ts exists",
    tier: 1,
    pass: existsSync(join(dir, "src/lsp/hover.ts")),
  });

  items.push({
    name: "dist/manifest.json exists",
    tier: 1,
    pass: existsSync(join(dir, "dist/manifest.json")),
  });

  const exampleCount = countSubdirs(join(dir, "examples"));
  items.push({
    name: "At least 1 example in examples/",
    tier: 1,
    pass: exampleCount > 0,
    detail: exampleCount > 0 ? `${exampleCount} example(s)` : undefined,
  });

  const hasPluginTest = findFiles(join(dir, "src"), (n) => n === "plugin.test.ts").length > 0;
  items.push({
    name: "plugin.test.ts exists",
    tier: 1,
    pass: hasPluginTest,
  });

  const hasSerializerTest = findFiles(join(dir, "src"), (n) => n === "serializer.test.ts").length > 0;
  items.push({
    name: "serializer.test.ts exists",
    tier: 1,
    pass: hasSerializerTest,
  });

  const mdxFiles = findFiles(join(dir, "docs"), (n) => n.endsWith(".mdx"));
  items.push({
    name: "At least 1 .mdx doc page",
    tier: 1,
    pass: mdxFiles.length > 0,
    detail: mdxFiles.length > 0 ? `${mdxFiles.length} page(s)` : undefined,
  });

  // ── Tier 2: Recommended ────────────────────────────────────────

  const pluginContent = readOr(join(dir, "src/plugin.ts"));

  for (const method of ["mcpTools", "mcpResources", "skills", "detectTemplate", "initTemplates"] as const) {
    // Check for uncommented method: line starts with optional whitespace, then the method name
    // Exclude lines that start with // or * (comment blocks)
    const lines = pluginContent.split("\n");
    const hasUncommented = lines.some((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith(`${method}(`) || trimmed.startsWith(`${method} (`);
    });
    items.push({
      name: `plugin.ts has uncommented ${method}`,
      tier: 2,
      pass: hasUncommented,
    });
  }

  const compositeFiles = listTsFiles(join(dir, "src/composites"), ["index.ts"]);
  items.push({
    name: "At least 1 composite in src/composites/",
    tier: 2,
    pass: compositeFiles.length > 0,
    detail: compositeFiles.length > 0 ? `${compositeFiles.length} composite(s)` : undefined,
  });

  items.push({
    name: "At least 3 examples",
    tier: 2,
    pass: exampleCount >= 3,
    detail: `${exampleCount} example(s)`,
  });

  items.push({
    name: "src/lsp/completions.test.ts exists",
    tier: 2,
    pass: existsSync(join(dir, "src/lsp/completions.test.ts")),
  });

  items.push({
    name: "src/lsp/hover.test.ts exists",
    tier: 2,
    pass: existsSync(join(dir, "src/lsp/hover.test.ts")),
  });

  const coverageContent = readOr(join(dir, "src/coverage.ts"));
  items.push({
    name: "coverage.ts is implemented",
    tier: 2,
    pass: !coverageContent.includes("not yet implemented"),
    detail: coverageContent.includes("not yet implemented") ? "contains 'not yet implemented'" : undefined,
  });

  items.push({
    name: "At least 8 doc pages",
    tier: 2,
    pass: mdxFiles.length >= 8,
    detail: `${mdxFiles.length} page(s)`,
  });

  // ── Tier 3: Thoroughness ───────────────────────────────────────

  // Each lint rule has a test
  const ruleDir = join(dir, "src/lint/rules");
  const ruleSourceFiles = listTsFiles(ruleDir, ["index.ts"]).filter((f) => !f.endsWith(".test.ts"));
  const ruleTestFiles = listTsFiles(ruleDir).filter((f) => f.endsWith(".test.ts"));
  const untestedRules = ruleSourceFiles.filter(
    (f) => !ruleTestFiles.includes(f.replace(".ts", ".test.ts")),
  );
  items.push({
    name: "Each lint rule has a .test.ts",
    tier: 3,
    pass: ruleSourceFiles.length > 0 && untestedRules.length === 0,
    detail: untestedRules.length > 0 ? `missing: ${untestedRules.join(", ")}` : undefined,
  });

  // Each post-synth has a test
  const postSynthDir = join(dir, "src/lint/post-synth");
  const postSynthSourceFiles = listTsFiles(postSynthDir, ["index.ts", "helpers.ts"]).filter(
    (f) => !f.endsWith(".test.ts"),
  );
  const postSynthTestFiles = listTsFiles(postSynthDir).filter((f) => f.endsWith(".test.ts"));
  const untestedPostSynth = postSynthSourceFiles.filter(
    (f) => !postSynthTestFiles.includes(f.replace(".ts", ".test.ts")),
  );
  items.push({
    name: "Each post-synth check has a .test.ts",
    tier: 3,
    pass: postSynthSourceFiles.length > 0 && untestedPostSynth.length === 0,
    detail: untestedPostSynth.length > 0 ? `missing: ${untestedPostSynth.join(", ")}` : undefined,
  });

  const hasTypecheckTest = findFiles(join(dir, "src"), (n) => n === "typecheck.test.ts").length > 0;
  items.push({
    name: "typecheck.test.ts exists",
    tier: 3,
    pass: hasTypecheckTest,
  });

  const hasRoundtripTest = findFiles(join(dir, "src"), (n) => n === "roundtrip.test.ts").length > 0;
  items.push({
    name: "roundtrip.test.ts exists",
    tier: 3,
    pass: hasRoundtripTest,
  });

  items.push({
    name: "At least 5 composites",
    tier: 3,
    pass: compositeFiles.length >= 5,
    detail: `${compositeFiles.length} composite(s)`,
  });

  const hasActions = existsSync(join(dir, "src/actions")) &&
    listTsFiles(join(dir, "src/actions"), ["index.ts"]).length > 0;
  items.push({
    name: "src/actions/ with at least 1 action",
    tier: 3,
    pass: hasActions,
  });

  // Examples with tests
  const examplesDir = join(dir, "examples");
  let examplesWithTests = 0;
  if (existsSync(examplesDir)) {
    for (const entry of readdirSync(examplesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const exampleTests = findFiles(join(examplesDir, entry.name), (n) => n.endsWith(".test.ts"));
      if (exampleTests.length > 0) examplesWithTests++;
    }
  }
  items.push({
    name: "At least 5 examples with tests",
    tier: 3,
    pass: examplesWithTests >= 5,
    detail: `${examplesWithTests} example(s) with tests`,
  });

  const tier1Pass = items.filter((i) => i.tier === 1).every((i) => i.pass);

  return { items, tier1Pass };
}

// ── Output formatting ────────────────────────────────────────────────

const COLORS = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function useColors(): boolean {
  return !process.env.NO_COLOR && process.stdout.isTTY !== false;
}

function c(text: string, code: string): string {
  return useColors() ? `${code}${text}${COLORS.reset}` : text;
}

/**
 * Print the check result as a colored table or JSON.
 */
export function printCheckResult(result: CheckResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const tierLabels: Record<number, string> = {
    1: "required",
    2: "recommended",
    3: "thoroughness",
  };

  for (const tier of [1, 2, 3] as const) {
    const tierItems = result.items.filter((i) => i.tier === tier);
    if (tierItems.length === 0) continue;

    const passCount = tierItems.filter((i) => i.pass).length;
    const label = tierLabels[tier];
    console.log("");
    console.log(c(`Tier ${tier} — ${label} (${passCount}/${tierItems.length})`, COLORS.bold));

    for (const item of tierItems) {
      let icon: string;
      let nameColor: string;

      if (item.pass) {
        icon = c("PASS", COLORS.green);
        nameColor = COLORS.green;
      } else if (tier === 1) {
        icon = c("FAIL", COLORS.red);
        nameColor = COLORS.red;
      } else if (tier === 2) {
        icon = c("WARN", COLORS.yellow);
        nameColor = COLORS.yellow;
      } else {
        icon = c("INFO", COLORS.gray);
        nameColor = COLORS.gray;
      }

      const detail = item.detail ? c(` (${item.detail})`, COLORS.gray) : "";
      console.log(`  ${icon}  ${c(item.name, nameColor)}${detail}`);
    }
  }

  console.log("");
  if (result.tier1Pass) {
    console.log(c("All tier-1 checks passed.", COLORS.green));
  } else {
    const failures = result.items.filter((i) => i.tier === 1 && !i.pass);
    console.log(c(`${failures.length} tier-1 check(s) failed.`, COLORS.red));
  }
}
