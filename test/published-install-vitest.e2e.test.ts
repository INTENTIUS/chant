/**
 * An installed chant resolves under vitest (#5130).
 *
 * #5130 stopped publishing `src/`, and the packages' `exports` still gave the
 * `development` condition a `src/*.ts` target. Vite and vitest add
 * `development` outside production, so every test file in a project that
 * installed 0.124.99 failed to import chant. This packs core and the k3s
 * lexicon as a release does, installs both plainly into a scratch project with
 * vitest, and runs a test that imports each. The test file runs under vitest's
 * own default conditions, so it fails the same way if an export lists a
 * condition vitest sets and a target the tarball lacks.
 *
 * Set CHANT_PUBLISHED_VERSION to install that version of both from the
 * registry instead of packing this checkout, to see the same run against a
 * release.
 *
 * End to end because `npm pack` runs both builds and `npm install` reads the
 * registry for the dependencies and vitest.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const coreRoot = join(repoRoot, "packages", "core");
const lexiconRoot = join(repoRoot, "lexicons", "k3s");
const published = process.env.CHANT_PUBLISHED_VERSION;

const TEST_FILE = `
import { describe, expect, test } from "vitest";

describe("an installed chant under vitest", () => {
  test("imports @intentius/chant and its subpaths", async () => {
    const core = await import("@intentius/chant");
    expect(Object.keys(core).length).toBeGreaterThan(0);
    const yaml = await import("@intentius/chant/yaml");
    expect(Object.keys(yaml).length).toBeGreaterThan(0);
    const op = await import("@intentius/chant/op");
    expect(Object.keys(op).length).toBeGreaterThan(0);
  });

  test("imports the k3s lexicon", async () => {
    const lexicon = await import("@intentius/chant-lexicon-k3s");
    expect(Object.keys(lexicon).length).toBeGreaterThan(0);
  });
});
`;

let scratch: string;
let consumer: string;

function pack(dir: string): string {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }),
  ) as { filename: string }[];
  return join(scratch, packed[0]!.filename);
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "chant-installed-vitest-"));
  consumer = join(scratch, "consumer");
  mkdirSync(consumer, { recursive: true });
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { devDependencies: Record<string, string> };
  const core = published ? published : `file:${pack(coreRoot)}`;
  const lexicon = published ? published : `file:${pack(lexiconRoot)}`;
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "installed-chant-vitest",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { "@intentius/chant": core, "@intentius/chant-lexicon-k3s": lexicon },
        devDependencies: { vitest: rootManifest.devDependencies.vitest },
        // The lexicon asks for a released chant; both resolve to the one under test.
        overrides: { "@intentius/chant": core },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(consumer, "installed.test.ts"), TEST_FILE);
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] });
}, 900_000);

describe("an installed chant under vitest (#5130)", () => {
  test("a plain vitest project imports core and a lexicon", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
    delete env.NODE_OPTIONS;
    delete env.VITEST;
    delete env.NODE_ENV;
    const result = spawnSync("npx", ["vitest", "run"], { cwd: consumer, env, encoding: "utf-8" });
    const output = `${result.stdout}${result.stderr}`;
    expect(output, output).toMatch(/Tests\s+2 passed/);
    expect(result.status).toBe(0);
  }, 300_000);
});
