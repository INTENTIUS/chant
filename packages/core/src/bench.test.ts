import { describe, test, expect } from "bun:test";
import { withTestDir } from "@intentius/chant-test-utils";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { discover } from "./discovery/index";
import { runLint } from "./lint/engine";
import { build } from "./build";
import type { Serializer } from "./serializer";
import { loadCoreRules } from "./lint/rules/index";

const coreRules = loadCoreRules();

interface FixtureSize {
  name: string;
  files: number;
  entitiesPerFile: number;
}

const sizes: FixtureSize[] = [
  { name: "Small", files: 4, entitiesPerFile: 2 },
  { name: "Medium", files: 20, entitiesPerFile: 2 },
  { name: "Large", files: 100, entitiesPerFile: 2 },
];

function generateFixtureFile(index: number, entitiesPerFile: number): string {
  const lines: string[] = [];
  for (let i = 0; i < entitiesPerFile; i++) {
    const n = index * entitiesPerFile + i;
    lines.push(`export const config_${n} = {
  lexicon: "bench",
  entityType: "Config",
  kind: "property",
  [Symbol.for("chant.declarable")]: true,
  algorithm: "AES256",
};

export const bucket_${n} = {
  lexicon: "bench",
  entityType: "Bucket",
  [Symbol.for("chant.declarable")]: true,
  bucketName: "bucket-${n}",
  encryption: config_${n},
};`);
  }
  return lines.join("\n\n");
}

async function generateFixture(dir: string, size: FixtureSize): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < size.files; i++) {
    const filePath = join(dir, `infra-${String(i).padStart(3, "0")}.ts`);
    await writeFile(filePath, generateFixtureFile(i, size.entitiesPerFile));
    files.push(filePath);
  }
  return files;
}

async function timeMs<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

async function benchmark<T>(fn: () => Promise<T>, runs: number = 5): Promise<{ min: number; avg: number; max: number; result: T }> {
  const times: number[] = [];
  let lastResult!: T;
  for (let i = 0; i < runs; i++) {
    const { result, ms } = await timeMs(fn);
    times.push(ms);
    lastResult = result;
  }
  return {
    min: Math.min(...times),
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    max: Math.max(...times),
    result: lastResult,
  };
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

const benchSerializer: Serializer = {
  name: "bench",
  rulePrefix: "BENCH",
  serialize: (entities) => JSON.stringify({ count: entities.size }),
};

describe("performance benchmarks", () => {
  test("benchmark suite", async () => {
    const output: string[] = [];
    output.push("");
    output.push("chant performance benchmarks");
    output.push("============================");
    output.push("");

    // --- Fixture generation ---
    output.push("Fixture generation:");

    for (const size of sizes) {
      await withTestDir(async (dir) => {
        const totalEntities = size.files * size.entitiesPerFile;
        const { ms } = await timeMs(() => generateFixture(dir, size));
        output.push(`  ${pad(`${size.name} (${size.files} files, ~${totalEntities} entities)`, 42)} ${fmt(ms)}`);
      });
    }

    output.push("");

    // --- Discovery ---
    output.push("Discovery:");

    for (const size of sizes) {
      await withTestDir(async (dir) => {
        await generateFixture(dir, size);
        const { avg } = await benchmark(() => discover(dir), 3);
        output.push(`  ${pad(size.name, 10)} ${fmt(avg)} (avg of 3 runs)`);
      });
    }

    output.push("");

    // --- Lint ---
    output.push(`Lint (${coreRules.length} core rules):`);

    for (const size of sizes) {
      await withTestDir(async (dir) => {
        const files = await generateFixture(dir, size);
        const { avg } = await benchmark(() => runLint(files, coreRules), 3);
        output.push(`  ${pad(size.name, 10)} ${fmt(avg)} (avg of 3 runs)`);
      });
    }

    output.push("");

    // --- Build ---
    output.push("Build (full pipeline):");

    for (const size of sizes) {
      await withTestDir(async (dir) => {
        await generateFixture(dir, size);
        const { avg } = await benchmark(() => build(dir, [benchSerializer]), 3);
        output.push(`  ${pad(size.name, 10)} ${fmt(avg)} (avg of 3 runs)`);
      });
    }

    output.push("");

    // --- Startup ---
    output.push("Startup:");

    {
      const { ms } = await timeMs(async () => {
        await import("@intentius/chant");
      });
      output.push(`  import("@intentius/chant")  ${fmt(ms)}`);
    }

    output.push("");

    // Print results
    const report = output.join("\n");
    console.log(report);

    // Sanity assertions — just verify the benchmarks actually ran
    expect(report).toContain("Discovery:");
    expect(report).toContain("Lint");
    expect(report).toContain("Build");
    expect(report).toContain("Startup:");
  }, 120_000);
});
