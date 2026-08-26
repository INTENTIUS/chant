import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rankFoldBlockers, toCollapsedFormat } from "./fold-rank";
import type { FoldDecision } from "./index";

describe("rankFoldBlockers", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-rank-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function run(file: string, reason = "unresolved identifier"): FoldDecision {
    return { file, mode: "run", reason };
  }
  function folded(file: string): FoldDecision {
    return { file, mode: "fold", resourceCount: 1 };
  }
  function reverseTaintedDecision(file: string, reason: string): FoldDecision {
    return { file, mode: "run", reason, reverseTainted: true };
  }

  test("a chain — one root-cause blocker retains every file behind it", async () => {
    // a.ts <- b.ts <- c.ts (b imports a, c imports b); all three fall back to run.
    const a = join(testDir, "a.ts");
    const b = join(testDir, "b.ts");
    const c = join(testDir, "c.ts");
    await writeFile(a, `export const a = process.env.X;`);
    await writeFile(b, `import { a } from "./a";\nexport const b = a;`);
    await writeFile(c, `import { b } from "./b";\nexport const c = b;`);

    const result = await rankFoldBlockers([run(a), run(b), run(c)]);

    expect(result.totalBlocked).toBe(3);
    const byFile = new Map(result.blockers.map((x) => [x.file, x]));
    expect(byFile.get(a)).toMatchObject({ retained: 3, topLevel: true });
    expect(byFile.get(b)).toMatchObject({ retained: 2, topLevel: false, dominatedBy: a });
    expect(byFile.get(c)).toMatchObject({ retained: 1, topLevel: false, dominatedBy: b });

    // Ranked descending by retained count — the root cause comes first.
    expect(result.blockers.map((x) => x.file)).toEqual([a, b, c]);
  });

  test("a diamond — a single root cause reached two ways is not double-counted", async () => {
    // root.ts <- {left.ts, right.ts} <- both.ts (both.ts imports BOTH left and right).
    const root = join(testDir, "root.ts");
    const left = join(testDir, "left.ts");
    const right = join(testDir, "right.ts");
    const both = join(testDir, "both.ts");
    await writeFile(root, `export const root = process.env.X;`);
    await writeFile(left, `import { root } from "./root";\nexport const left = root;`);
    await writeFile(right, `import { root } from "./root";\nexport const right = root;`);
    await writeFile(
      both,
      `import { left } from "./left";\nimport { right } from "./right";\nexport const both = left + right;`,
    );

    const result = await rankFoldBlockers([run(root), run(left), run(right), run(both)]);

    expect(result.totalBlocked).toBe(4);
    const rootBlocker = result.blockers.find((x) => x.file === root)!;
    // root retains ALL FOUR files — left, right, and "both" reached via
    // either path — not eight (double-counted through the diamond).
    expect(rootBlocker.retained).toBe(4);
    expect(rootBlocker.topLevel).toBe(true);

    const bothBlocker = result.blockers.find((x) => x.file === both)!;
    expect(bothBlocker.retained).toBe(1);

    // Conservation: top-level blockers' retained counts sum to totalBlocked.
    const topLevelSum = result.blockers.filter((x) => x.topLevel).reduce((s, x) => s + x.retained, 0);
    expect(topLevelSum).toBe(result.totalBlocked);
  });

  test("two independent blockers — a shared dependent is not credited to either", async () => {
    // x.ts and y.ts fail independently (no relation to each other).
    // both.ts imports both, and needs BOTH fixed to fold — so it is its
    // own top-level entry, inflating neither x's nor y's retained count.
    const x = join(testDir, "x.ts");
    const y = join(testDir, "y.ts");
    const both = join(testDir, "both.ts");
    await writeFile(x, `export const x = process.env.X;`);
    await writeFile(y, `export const y = process.env.Y;`);
    await writeFile(both, `import { x } from "./x";\nimport { y } from "./y";\nexport const both = x + y;`);

    const result = await rankFoldBlockers([run(x), run(y), run(both)]);

    expect(result.totalBlocked).toBe(3);
    const byFile = new Map(result.blockers.map((b) => [b.file, b]));
    expect(byFile.get(x)).toMatchObject({ retained: 1, topLevel: true });
    expect(byFile.get(y)).toMatchObject({ retained: 1, topLevel: true });
    // "both" is dominated by neither x nor y alone — it becomes its own
    // top-level entry rather than inflating either blocker.
    expect(byFile.get(both)).toMatchObject({ retained: 1, topLevel: true });

    const topLevelSum = result.blockers.filter((b) => b.topLevel).reduce((s, b) => s + b.retained, 0);
    expect(topLevelSum).toBe(3);
  });

  test("a reverse-tainted file is reported separately and never enters the tree", async () => {
    const blocker = join(testDir, "blocker.ts");
    const wouldFold = join(testDir, "would-fold.ts");
    await writeFile(blocker, `import { p } from "./would-fold";\nexport const b = p + process.env.X;`);
    await writeFile(wouldFold, `export const p = "fine";`);

    const decisions: FoldDecision[] = [
      run(blocker),
      reverseTaintedDecision(
        wouldFold,
        "would fold in isolation, but a file that imports it (directly or transitively) falls back to run — folding independently would create a duplicate, non-identical instance",
      ),
    ];

    const result = await rankFoldBlockers(decisions);

    expect(result.totalBlocked).toBe(1);
    expect(result.blockers.map((b) => b.file)).toEqual([blocker]);
    expect(result.reverseTainted).toEqual([
      {
        file: wouldFold,
        reason:
          "would fold in isolation, but a file that imports it (directly or transitively) falls back to run — folding independently would create a duplicate, non-identical instance",
      },
    ]);
  });

  test("fold-mode files are excluded from the tree entirely", async () => {
    const okFile = join(testDir, "ok.ts");
    const badFile = join(testDir, "bad.ts");
    await writeFile(okFile, `export const ok = 1;`);
    await writeFile(badFile, `export const bad = process.env.X;`);

    const result = await rankFoldBlockers([folded(okFile), run(badFile)]);

    expect(result.totalBlocked).toBe(1);
    expect(result.blockers.map((b) => b.file)).toEqual([badFile]);
  });

  test("retained counts are conserved across a mixed graph (chain + independent leaf)", async () => {
    const a = join(testDir, "a.ts");
    const b = join(testDir, "b.ts");
    const leaf = join(testDir, "leaf.ts");
    await writeFile(a, `export const a = process.env.X;`);
    await writeFile(b, `import { a } from "./a";\nexport const b = a;`);
    await writeFile(leaf, `export const leaf = process.env.Y;`); // unrelated second root cause

    const result = await rankFoldBlockers([run(a), run(b), run(leaf)]);

    expect(result.totalBlocked).toBe(3);
    const topLevelSum = result.blockers.filter((x) => x.topLevel).reduce((s, x) => s + x.retained, 0);
    expect(topLevelSum).toBe(3);
    // a.ts ranks ahead of leaf.ts (retains 2 vs 1) — sorted descending.
    expect(result.blockers[0].file).toBe(a);
    expect(result.blockers[0].retained).toBe(2);
  });
});

describe("toCollapsedFormat", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-fold-rank-collapsed-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("emits one weighted line per file, folding to retained counts under a shared root frame", async () => {
    const a = join(testDir, "a.ts");
    const b = join(testDir, "b.ts");
    await writeFile(a, `export const a = process.env.X;`);
    await writeFile(b, `import { a } from "./a";\nexport const b = a;`);

    const result = await rankFoldBlockers([
      { file: a, mode: "run", reason: "r" },
      { file: b, mode: "run", reason: "r" },
    ]);
    const lines = toCollapsedFormat(result, { relativeTo: testDir });

    expect(lines.sort()).toEqual(["fold;a.ts 1", "fold;a.ts;b.ts 1"].sort());

    // Every line for a's own subtree (its own line, plus every line whose
    // stack is prefixed by it) sums to a's retained count.
    const aPrefixCount = lines.filter((l) => l.startsWith("fold;a.ts")).length;
    const aBlocker = result.blockers.find((x) => x.file === a)!;
    expect(aPrefixCount).toBe(aBlocker.retained);
  });
});
