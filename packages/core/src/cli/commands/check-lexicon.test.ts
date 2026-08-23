import { describe, test, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLexicon } from "./check-lexicon";

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
