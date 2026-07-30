/**
 * chant #1218 — the lexicon-upgrade wiring is four hand-maintained lists
 * that must agree: the workflow matrix, the ops/lexicon-upgrade/*.op.ts
 * files, the rolling-lexicon dispatch set, and each op file's own
 * `lexicon:` argument. fly joined the matrix without an op file and every
 * scheduled run failed for three weeks with `Op "fly-upgrade" not found`.
 * This test turns the next miswiring into a PR-time failure.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isRolling, type SupportedLexicon } from "./lexicon-upgrade";
import { IN_SCOPE_LEXICONS } from "../../composites/lexicon-upgrade-op";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

function matrixLexicons(): string[] {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "lexicon-upgrade.yml"), "utf-8");
  const match = workflow.match(/lexicon:\s*\[([^\]]+)\]/);
  if (!match) throw new Error("lexicon-upgrade.yml: matrix `lexicon: [...]` not found");
  return match[1].split(",").map((s) => s.trim());
}

function opFileLexicons(): string[] {
  return readdirSync(join(repoRoot, "ops", "lexicon-upgrade"))
    .filter((f) => f.endsWith("-upgrade.op.ts"))
    .map((f) => f.replace(/-upgrade\.op\.ts$/, ""));
}

describe("lexicon-upgrade wiring consistency (#1218)", () => {
  it("every matrix lexicon has an op file, and vice versa", () => {
    const matrix = [...matrixLexicons()].sort();
    const ops = [...opFileLexicons()].sort();
    expect(ops).toEqual(matrix);
  });

  it("every op file's lexicon argument matches its filename", () => {
    for (const name of opFileLexicons()) {
      const content = readFileSync(join(repoRoot, "ops", "lexicon-upgrade", `${name}-upgrade.op.ts`), "utf-8");
      const match = content.match(/lexicon:\s*"([^"]+)"/);
      expect(match, `${name}-upgrade.op.ts must pass a literal lexicon name`).toBeTruthy();
      expect(match![1]).toBe(name);
    }
  });

  it("the composite's IN_SCOPE_LEXICONS matches the matrix", () => {
    // The fifth list. fly had an op file *and* a matrix entry designed, but
    // the composite's own scope gate rejected it — verify they agree too.
    expect([...IN_SCOPE_LEXICONS].sort()).toEqual([...matrixLexicons()].sort());
  });

  it("every rolling lexicon is in the matrix", () => {
    const matrix = new Set(matrixLexicons());
    // The rolling set is enumerated in the dispatch module; isRolling is the
    // exported membership test. Anything rolling but unlisted would silently
    // get no weekly drift check at all.
    const known = ["aws", "azure", "github", "fly", "fountain", "k8s", "gcp", "docker", "gitlab"];
    for (const lexicon of known.filter((l) => isRolling(l as SupportedLexicon))) {
      expect(matrix.has(lexicon), `rolling lexicon "${lexicon}" missing from the workflow matrix`).toBe(true);
    }
  });
});
