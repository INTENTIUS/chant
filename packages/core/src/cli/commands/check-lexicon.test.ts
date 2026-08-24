import { describe, test, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLexicon, coverageReportCheck } from "./check-lexicon";
import { loadLexiconFromDir } from "./check-lexicon-plugin";
import type { LexiconPlugin } from "../../lexicon";

// chant #1067 — check-lexicon.ts had zero tests before this issue, despite
// being the tool meant to gate every lexicon's completeness. This locks in
// that checkLexicon() actually wires the new semantic checks (intrinsic
// foldability audit, example-build audit) into its tier-1 results — not
// just the pre-existing existence/count checks — against a real,
// already-built lexicon in this repo.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const gitlabDir = join(repoRoot, "lexicons", "gitlab");

describe("checkLexicon", () => {
  test("includes the new #1067 tier-1 checks by name", async () => {
    const result = await checkLexicon(gitlabDir);
    const names = result.items.map((i) => i.name);
    expect(names).toContain("Every shipped example builds and passes its own post-synth checks");
    expect(names).toContain("Registered intrinsics are exported by the package");
    expect(names).toContain("Registered intrinsics' isTag matches how they're authored");
    expect(names).toContain("dist/manifest.json declares a chantVersion");
    expect(names).toContain('package.json routes exports["."].default at ./src/index.ts and deletes emitted JS in build');
  });

  test("gitlab's own reference() intrinsic passes both the export and isTag audits", async () => {
    const result = await checkLexicon(gitlabDir);
    const exported = result.items.find((i) => i.name === "Registered intrinsics are exported by the package");
    const matches = result.items.find((i) => i.name === "Registered intrinsics' isTag matches how they're authored");
    expect(exported?.pass).toBe(true);
    expect(matches?.pass).toBe(true);
  });
});

// chant #1330 — fountain's spec-coverage gate lived only in its own
// coverage.test.ts, a convention rather than a check-lexicon contract. These
// lock in the tier-1 check over the plugin's coverageReport() member: red on
// an unaccounted kind, vacuous pass without the member, red on a throw, and
// green against the real fountain lexicon in this repo.
describe("coverageReportCheck", () => {
  test("fails when the report leaves a kind unaccounted", async () => {
    const plugin = {
      coverageReport: async () => ({ unaccountedKinds: ["SandboxRequest"] }),
    } as unknown as LexiconPlugin;
    const item = await coverageReportCheck(plugin);
    expect(item.tier).toBe(1);
    expect(item.pass).toBe(false);
    expect(item.detail).toContain("SandboxRequest");
  });

  test("passes vacuously when the plugin has no coverageReport", async () => {
    const item = await coverageReportCheck({} as LexiconPlugin);
    expect(item.pass).toBe(true);
    expect(item.detail).toBeUndefined();
  });

  test("fails when the report throws", async () => {
    const plugin = {
      coverageReport: async () => {
        throw new Error("snapshot missing");
      },
    } as unknown as LexiconPlugin;
    const item = await coverageReportCheck(plugin);
    expect(item.pass).toBe(false);
    expect(item.detail).toContain("snapshot missing");
  });

  test("is green on the current fountain lexicon", async () => {
    const loaded = await loadLexiconFromDir(join(repoRoot, "lexicons", "fountain"));
    expect(loaded.plugin).toBeDefined();
    const item = await coverageReportCheck(loaded.plugin);
    expect(item.pass).toBe(true);
    expect(item.detail).toBe("all spec kinds accounted for");
  });
});
