import { describe, test, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { newFileDiff, unifiedDiff } from "./unified-diff";

const OLD = `resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
  environment {
    variables = {
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
    }
  }
}
`;
const NEW = OLD.replace("aws_s3_bucket.assets.bucket", "data.aws_s3_bucket.assets.bucket");

describe("unifiedDiff", () => {
  test("identical inputs produce no diff", () => {
    expect(unifiedDiff("main.tf", OLD, OLD)).toBe("");
  });

  test("a one-line rewrite yields one hunk with context and git headers", () => {
    const patch = unifiedDiff("main.tf", OLD, NEW);
    const lines = patch.split("\n");
    expect(lines[0]).toBe("diff --git a/main.tf b/main.tf");
    expect(lines[1]).toBe("--- a/main.tf");
    expect(lines[2]).toBe("+++ b/main.tf");
    expect(lines[3]).toBe("@@ -2,7 +2,7 @@");
    expect(patch).toContain("-      ASSETS_BUCKET = aws_s3_bucket.assets.bucket");
    expect(patch).toContain("+      ASSETS_BUCKET = data.aws_s3_bucket.assets.bucket");
    // 3 context lines either side of the change.
    expect(lines.filter((l) => l.startsWith(" "))).toHaveLength(6);
  });

  test("distant changes split into separate hunks; close ones join", () => {
    const hunkHeaders = (patch: string) => patch.split("\n").filter((l) => l.startsWith("@@"));
    const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const twoFar = oldText.replace("line 2", "LINE 2").replace("line 17", "LINE 17");
    expect(hunkHeaders(unifiedDiff("f.txt", oldText, twoFar))).toHaveLength(2);
    const twoNear = oldText.replace("line 8", "LINE 8").replace("line 10", "LINE 10");
    expect(hunkHeaders(unifiedDiff("f.txt", oldText, twoNear))).toHaveLength(1);
  });

  test("marks a missing trailing newline", () => {
    const patch = unifiedDiff("f.txt", "a\nb\n", "a\nb2");
    expect(patch).toContain("+b2\n\\ No newline at end of file");
  });

  test("newFileDiff renders /dev/null → b/<path>", () => {
    const patch = newFileDiff("ds.tf", 'data "aws_s3_bucket" "assets" {\n  bucket = "b"\n}\n');
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/ds.tf");
    expect(patch).toContain("@@ -0,0 +1,3 @@");
  });

  test("git apply accepts the combined patch and reproduces the new content", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-udiff-"));
    try {
      writeFileSync(join(dir, "main.tf"), OLD);
      const patch = unifiedDiff("main.tf", OLD, NEW) + newFileDiff("ds.tf", 'data "x" "y" {}\n');
      writeFileSync(join(dir, "bridge.patch"), patch);
      try {
        execFileSync("git", ["apply", "bridge.patch"], { cwd: dir });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no git on this machine
        throw err;
      }
      expect(readFileSync(join(dir, "main.tf"), "utf-8")).toBe(NEW);
      expect(readFileSync(join(dir, "ds.tf"), "utf-8")).toBe('data "x" "y" {}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
