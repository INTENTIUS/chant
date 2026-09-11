/**
 * chant#2403 — pins generate-scale-estate.ts's formula (perStack =
 * 2*teamsPerStack + 6, total = stacks*perStack) against what the generator
 * ACTUALLY emits: real resource-count assertions on the generated files, not
 * just a re-statement of the arithmetic. A regression that changes the shape
 * (drops a supporting resource, stops pairing Policy with Role, lets a stack
 * over the 500 cap) fails here even if the arithmetic functions still agree
 * with themselves.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateEstate, parseArgs, planEstate } from "./generate-scale-estate";

/** Counts declared resource instances in one stack's resources.ts by the
 * same seams the file itself is built from: `new Role(`, `new Policy(`,
 * `new S3BucketPolicy(`, `DynamoDBTable(` (a Composite call, not `new`) and
 * the other plain `new X(` supporting types. `new Bucket(` is matched with a
 * trailing word boundary so it never also counts `new S3BucketPolicy(`. */
function countResourcesInSource(src: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of ["Role", "Policy", "Bucket", "S3BucketPolicy", "Queue", "Topic", "LogGroup"]) {
    counts[type] = (src.match(new RegExp(`new ${type}\\(`, "g")) ?? []).length;
  }
  counts.DynamoDBTable = (src.match(/DynamoDBTable\(/g) ?? []).length;
  return counts;
}

function withGeneratedEstate<T>(argv: string[], fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "chant-scale-estate-test-"));
  try {
    const args = parseArgs(["--out", dir, ...argv]);
    generateEstate(args);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("planEstate", () => {
  it("states the formula: perStack = 2*teamsPerStack + 6", () => {
    const plan = planEstate(parseArgs(["--out", "unused", "--stacks", "3", "--teams-per-stack", "20"]));
    expect(plan.perStackResources).toBe(2 * 20 + 6);
    expect(plan.totalResources).toBe(3 * (2 * 20 + 6));
  });

  it("defaults teamsPerStack to 190, giving 386 resources per stack", () => {
    const plan = planEstate(parseArgs(["--out", "unused", "--stacks", "1"]));
    expect(plan.perStackResources).toBe(386);
  });

  it("refuses a teamsPerStack that would push a stack over the safe max", () => {
    expect(() => planEstate(parseArgs(["--out", "unused", "--stacks", "1", "--teams-per-stack", "300"]))).toThrow(
      /over the safe max/,
    );
  });

  it("--resources rounds UP to a whole number of full-size stacks", () => {
    // perStack(20) = 46; 100 resources needs 3 full stacks (138), never a
    // partial 4th stack.
    const plan = planEstate(parseArgs(["--out", "unused", "--resources", "100", "--teams-per-stack", "20"]));
    expect(plan.stackCount).toBe(3);
    expect(plan.totalResources).toBe(138);
  });

  it("rejects --stacks and --resources together", () => {
    expect(() => parseArgs(["--out", "unused", "--stacks", "1", "--resources", "1"])).toThrow();
  });
});

describe("generateEstate", () => {
  it("emits exactly the planned number of stacks, each under the real CloudFormation cap", () => {
    withGeneratedEstate(["--stacks", "3", "--teams-per-stack", "20"], (dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, "estate-manifest.json"), "utf8"));
      expect(manifest.stacks).toBe(3);
      expect(manifest.totalResources).toBe(138);
      expect(manifest.stackNames).toHaveLength(3);

      for (const stackName of manifest.stackNames) {
        const src = readFileSync(join(dir, "src", stackName, "resources.ts"), "utf8");
        const counts = countResourcesInSource(src);
        // 20 teams * (Role + Policy) = 40, plus the 6 fixed supporting types.
        expect(counts.Role).toBe(20);
        expect(counts.Policy).toBe(20);
        expect(counts.Bucket).toBe(1);
        expect(counts.S3BucketPolicy).toBe(1);
        expect(counts.Queue).toBe(1);
        expect(counts.Topic).toBe(1);
        expect(counts.LogGroup).toBe(1);
        expect(counts.DynamoDBTable).toBe(1);
        const total =
          counts.Role + counts.Policy + counts.Bucket + counts.S3BucketPolicy + counts.Queue + counts.Topic + counts.LogGroup + counts.DynamoDBTable;
        expect(total).toBe(46);
        expect(total).toBeLessThan(500); // the real CloudFormation cap, never brushed
      }
    });
  });

  it("every export name is globally unique across the whole estate (no cross-stack collision)", () => {
    withGeneratedEstate(["--stacks", "3", "--teams-per-stack", "5"], (dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, "estate-manifest.json"), "utf8"));
      const allExports = new Set<string>();
      for (const stackName of manifest.stackNames) {
        const src = readFileSync(join(dir, "src", stackName, "resources.ts"), "utf8");
        for (const m of src.matchAll(/export const (\w+)/g)) {
          expect(allExports.has(m[1])).toBe(false);
          allExports.add(m[1]);
        }
      }
      // 3 stacks * (5 teams * 2 + 6 supporting) = 3 * 16 = 48 exports.
      expect(allExports.size).toBe(48);
    });
  });

  it("writes a chant.config.ts with one stacks[] entry per generated stack, and an ownership block", () => {
    withGeneratedEstate(["--stacks", "2", "--teams-per-stack", "5"], (dir) => {
      const config = readFileSync(join(dir, "chant.config.ts"), "utf8");
      expect(config).toContain("scale-stack-000");
      expect(config).toContain("scale-stack-001");
      expect(config).toMatch(/stacks:\s*\[/);
      expect(config).toMatch(/ownership:\s*{\s*stack:/);
    });
  });

  it("writes one *.component.ts per stack, naming that stack's own cfn-deploy target", () => {
    withGeneratedEstate(["--stacks", "2", "--teams-per-stack", "5"], (dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, "estate-manifest.json"), "utf8"));
      for (const stackName of manifest.stackNames) {
        const files = readdirSync(join(dir, "src", stackName));
        expect(files).toContain("stack.component.ts");
        const component = readFileSync(join(dir, "src", stackName, "stack.component.ts"), "utf8");
        expect(component).toContain(`name: "${stackName}"`);
        expect(component).toContain(`stack: "${stackName}"`);
        expect(component).toContain(`template: "src/${stackName}/template.json"`);
      }
    });
  });
});
