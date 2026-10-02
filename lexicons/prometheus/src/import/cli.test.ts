/**
 * `chant import <file>` end to end through core's import command: detection
 * from a project that lists the prometheus lexicon, `--lexicon prometheus`
 * without one, the files written, and `chant build` on them giving the file
 * back.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import { importCommand } from "@intentius/chant/cli/commands/import";
import { prometheusSerializer } from "../serializer";
import { builtFiles, exampleOutputs, pkgDir, read } from "./testdata/fixtures";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

async function rebuilt(srcDir: string): Promise<{ rules?: string; alertmanager?: string }> {
  const result = await build(srcDir, [prometheusSerializer]);
  expect(result.errors).toEqual([]);
  return builtFiles(result.outputs.get("prometheus"));
}

describe("chant import", () => {
  test("detects a rule file in a project that lists prometheus", async () => {
    writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: ["prometheus"] }));
    const templatePath = write("rules.yml", read("rules-full.yml"));
    const output = join(dir, "src");

    const result = await importCommand({ templatePath, output });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("prometheus");
    expect(result.generatedFiles).toEqual(["rules.ts"]);
    expect(readFileSync(join(output, "rules.ts"), "utf-8")).toContain("new RuleGroup(");
    const { rules } = await rebuilt(output);
    expect(load(rules!)).toEqual(expect.objectContaining({ groups: expect.any(Array) }));
  }, 30_000);

  test("detects an alertmanager.yml in a project that lists prometheus", async () => {
    writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: ["prometheus"] }));
    const am = (await exampleOutputs()).find((o) => o.name === "alerting/alertmanager.yml")!;
    const templatePath = write("alertmanager.yml", am.yaml);
    const output = join(dir, "src");

    const result = await importCommand({ templatePath, output });

    expect(result.error).toBeUndefined();
    expect(result.lexicon).toBe("prometheus");
    expect(result.generatedFiles).toEqual(["receivers.ts", "time-intervals.ts", "routes.ts", "inhibit-rules.ts", "settings.ts"]);
    expect((await rebuilt(output)).alertmanager).toBe(am.yaml);
  }, 30_000);

  test("--lexicon prometheus imports without a project, and prints what it rewrote", async () => {
    const templatePath = write("alertmanager.yml", read("alertmanager-full.yml"));
    const output = join(dir, "src");

    // Without a project, detection tries every installed lexicon (#2965).
    const detected = await importCommand({ templatePath, output: join(dir, "detected") });
    expect(detected.error).toBeUndefined();
    expect(detected.lexicon).toBe("prometheus");
    expect(detected.detected).toBe(true);

    const result = await importCommand({ templatePath, output, lexicon: "prometheus" });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("prometheus");
    expect(result.warnings.some((w) => w.includes("match/match_re are written as matchers"))).toBe(true);
    const { alertmanager } = await rebuilt(output);
    expect(alertmanager).toContain('- severity="page"');
    expect(alertmanager).toContain("name: weekends");
  }, 30_000);

  test("--lexicon prometheus on a file that is neither names both shapes", async () => {
    const templatePath = write("collector.yaml", "receivers:\n  otlp: {}\nservice:\n  pipelines: {}\n");
    const result = await importCommand({ templatePath, output: join(dir, "src"), lexicon: "prometheus" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("rule file");
    expect(result.error).toContain("alertmanager.yml");
  });
});
