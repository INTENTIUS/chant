/**
 * chant#2591 — the static reader of a config's `lexicons`: what it reads, and
 * what it reports as unreadable instead of running the config.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLexiconDeclarationsStatically, unknownPathLexiconsNotice } from "./config-static";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-2591-static-")));
  // A project boundary, so the upward walk stops here.
  writeFileSync(join(dir, "package.json"), "{}");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readTs(source: string) {
  writeFileSync(join(dir, "chant.config.ts"), source);
  return readLexiconDeclarationsStatically(dir);
}

const SITE = { name: "site", module: "./lexicon/index.ts" };

describe("readable configs", () => {
  test.each([
    ["an object literal default export", `export default { lexicons: ["aws", { name: "site", module: "./lexicon/index.ts" }] };`],
    [
      "satisfies and a type import",
      `import type { ChantConfig } from "@intentius/chant";\nexport default { lexicons: ["aws", { name: "site", module: "./lexicon/index.ts" }] } satisfies ChantConfig;`,
    ],
    [
      "a const alias",
      `const config = { lexicons: ["aws", { name: "site", module: "./lexicon/index.ts" }], sourceDir: "src" };\nexport default config;`,
    ],
    ["a named config export", `export const config = { lexicons: ["aws", { name: "site", module: "./lexicon/index.ts" }] };`],
    ["named exports", `export const lexicons = ["aws", { name: "site", module: "./lexicon/index.ts" }];\nexport const sourceDir = "src";`],
    [
      "consts, a spread and a template",
      `const dir = "lexicon";\nconst base = ["aws"];\nexport default { lexicons: [...base, { name: "site", module: \`./\${dir}/index.ts\` }] };`,
    ],
    [
      "a spread config",
      `const shared = { lexicons: ["aws", { name: "site", module: "./lexicon/index.ts" }] };\nexport default { ...shared, sourceDir: "src" };`,
    ],
    [
      "other keys that are not readable",
      `import { plugin } from "./rules";\nexport default { lexicons: ["aws", { name: "site", module: "./lexicon/index.ts" }], lint: { plugins: [plugin()] } };`,
    ],
  ])("%s", (_label, source) => {
    const read = readTs(source);
    expect(read).toEqual({ status: "read", configPath: join(dir, "chant.config.ts"), entries: ["aws", SITE] });
  });

  test("a same-file function the fold subset covers is interpreted, not run", () => {
    const read = readTs(`const pick = (extra) => ["aws", extra];\nexport default { lexicons: pick("k8s") };`);
    expect(read).toMatchObject({ status: "read", entries: ["aws", "k8s"] });
  });

  test("a config with no lexicons reads as none", () => {
    expect(readTs(`export default { sourceDir: "src" };`)).toMatchObject({ status: "read", entries: [] });
  });

  test("chant.config.json is parsed", () => {
    writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: ["aws", SITE] }));
    expect(readLexiconDeclarationsStatically(dir)).toMatchObject({ status: "read", entries: ["aws", SITE] });
  });

  test("the walk goes up from a subdirectory", () => {
    writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: [{ name: "site", module: "./lexicon/index.ts" }] };`);
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    expect(readLexiconDeclarationsStatically(join(dir, "src", "deep"))).toMatchObject({ status: "read", entries: [SITE] });
  });

  test("no config", () => {
    expect(readLexiconDeclarationsStatically(dir)).toEqual({ status: "no-config" });
  });
});

describe("unreadable configs are reported, never run", () => {
  test.each([
    ["an imported binding", `import { lexicons } from "./shared";\nexport default { lexicons };`, /lexicons/],
    ["process.env", `export default { lexicons: process.env.CI ? ["aws"] : ["aws", "k8s"] };`, /process/],
    ["a call as the default export", `export default defineConfig({ lexicons: ["aws"] });`, /not an object literal/],
    ["a re-export", `export { default } from "./base";`, /export/],
    ["an imported function in lexicons", `import { pick } from "./pick";\nexport default { lexicons: pick() };`, /line 4: .*pick/],
    ["entries of the wrong shape", `export default { lexicons: [{ name: "site" }] };`, /not a list of lexicon entries/],
  ])("%s", (_label, source, reason) => {
    const marker = join(dir, "ran");
    const read = readTs(`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n${source}`);
    expect(read.status).toBe("unknown");
    expect(read.status === "unknown" && read.reason).toMatch(reason);
    expect(unknownPathLexiconsNotice(read)).toContain("is unknown here and is treated as a package");
    expect(existsSync(marker)).toBe(false);
  });

  test("a readable config has no notice", () => {
    expect(unknownPathLexiconsNotice(readTs(`export default { lexicons: ["aws"] };`))).toBeUndefined();
  });
});
