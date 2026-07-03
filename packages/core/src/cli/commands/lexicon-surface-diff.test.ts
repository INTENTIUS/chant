import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { RegenResult } from "../../codegen/lexicon-regen";

// Stub the heavy regen pipeline — these tests only exercise the re-baseline /
// version-bump wiring (#616), not the actual spec fetch + tsc build.
const regenLexicon = vi.fn<(...a: unknown[]) => Promise<RegenResult>>();
const writeSurfaceSnapshot = vi.fn();
vi.mock("../../codegen/lexicon-regen", () => ({
  regenLexicon: (...args: unknown[]) => regenLexicon(...args),
  writeSurfaceSnapshot: (...args: unknown[]) => writeSurfaceSnapshot(...args),
  SNAPSHOT_FILENAME: "surface.snapshot.json",
}));

import { runSurfaceDiff } from "./lexicon-surface-diff";

function result(over: Partial<RegenResult>): RegenResult {
  return {
    ok: true,
    changed: true,
    severity: "additive",
    delta: { added: [], changed: [], removed: [], severity: "additive" },
    deltaText: "",
    failures: [],
    freshSnapshot: { surface: "x" } as unknown as RegenResult["freshSnapshot"],
    ...over,
  };
}

function lexiconDir(version = "0.13.1"): string {
  const dir = mkdtempSync(join(tmpdir(), "sd-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lex", version }, null, 2) + "\n");
  return dir;
}

function readVersion(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version: string }).version;
}

describe("runSurfaceDiff --bump (#616)", () => {
  beforeEach(() => {
    regenLexicon.mockReset();
    writeSurfaceSnapshot.mockReset();
  });

  test("additive drift with --update-snapshot --bump bumps the patch", async () => {
    const dir = lexiconDir("0.13.1");
    try {
      regenLexicon.mockResolvedValue(result({ severity: "additive" }));
      await runSurfaceDiff({ lexiconDir: dir, updateSnapshot: true, bump: true });
      expect(readVersion(dir)).toBe("0.13.2");
      expect(writeSurfaceSnapshot).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("breaking drift bumps the minor (pre-1.0)", async () => {
    const dir = lexiconDir("0.13.1");
    try {
      regenLexicon.mockResolvedValue(result({ severity: "breaking" }));
      await runSurfaceDiff({ lexiconDir: dir, updateSnapshot: true, bump: true });
      expect(readVersion(dir)).toBe("0.14.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no --bump leaves the version untouched even when the surface changed", async () => {
    const dir = lexiconDir("0.13.1");
    try {
      regenLexicon.mockResolvedValue(result({ severity: "additive" }));
      await runSurfaceDiff({ lexiconDir: dir, updateSnapshot: true });
      expect(readVersion(dir)).toBe("0.13.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--bump with no surface change leaves the version untouched", async () => {
    const dir = lexiconDir("0.13.1");
    try {
      regenLexicon.mockResolvedValue(result({ changed: false, severity: "none" }));
      await runSurfaceDiff({ lexiconDir: dir, updateSnapshot: true, bump: true });
      expect(readVersion(dir)).toBe("0.13.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--bump without --update-snapshot does nothing (no re-baseline, no bump)", async () => {
    const dir = lexiconDir("0.13.1");
    try {
      regenLexicon.mockResolvedValue(result({ severity: "additive" }));
      await runSurfaceDiff({ lexiconDir: dir, bump: true });
      expect(readVersion(dir)).toBe("0.13.1");
      expect(writeSurfaceSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
