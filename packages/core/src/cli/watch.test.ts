import { describe, test, expect } from "bun:test";
import { shouldWatch, formatTimestamp, formatChangedFiles } from "./watch";

describe("shouldWatch", () => {
  const defaults = {
    debounceMs: 300,
    extensions: [".ts"],
    ignoreDirs: ["node_modules", ".chant"],
  };

  test("accepts .ts files", () => {
    expect(shouldWatch("src/bucket.ts", defaults)).toBe(true);
  });

  test("rejects non-.ts files", () => {
    expect(shouldWatch("src/readme.md", defaults)).toBe(false);
  });

  test("rejects test files", () => {
    expect(shouldWatch("src/bucket.test.ts", defaults)).toBe(false);
    expect(shouldWatch("src/bucket.spec.ts", defaults)).toBe(false);
  });

  test("rejects node_modules", () => {
    expect(shouldWatch("node_modules/foo/index.ts", defaults)).toBe(false);
  });

  test("rejects .chant directory", () => {
    expect(shouldWatch(".chant/types/core/index.ts", defaults)).toBe(false);
  });

  test("rejects dotdirs", () => {
    expect(shouldWatch(".git/hooks/pre-commit.ts", defaults)).toBe(false);
    expect(shouldWatch(".vscode/settings.ts", defaults)).toBe(false);
  });

  test("accepts nested .ts files", () => {
    expect(shouldWatch("src/infra/data-bucket.ts", defaults)).toBe(true);
  });
});

describe("formatTimestamp", () => {
  test("formats as HH:MM:SS", () => {
    const date = new Date(2024, 0, 1, 9, 5, 3);
    expect(formatTimestamp(date)).toBe("09:05:03");
  });

  test("pads single digits", () => {
    const date = new Date(2024, 0, 1, 1, 2, 3);
    expect(formatTimestamp(date)).toBe("01:02:03");
  });

  test("handles midnight", () => {
    const date = new Date(2024, 0, 1, 0, 0, 0);
    expect(formatTimestamp(date)).toBe("00:00:00");
  });
});

describe("formatChangedFiles", () => {
  test("shows all files when count <= maxShow", () => {
    const result = formatChangedFiles(
      ["/project/src/a.ts", "/project/src/b.ts"],
      "/project",
    );
    expect(result).toBe("src/a.ts, src/b.ts");
  });

  test("truncates when count > maxShow", () => {
    const result = formatChangedFiles(
      ["/project/src/a.ts", "/project/src/b.ts", "/project/src/c.ts", "/project/src/d.ts"],
      "/project",
      2,
    );
    expect(result).toBe("src/a.ts, src/b.ts (+2 more)");
  });

  test("shows single file", () => {
    const result = formatChangedFiles(["/project/src/a.ts"], "/project");
    expect(result).toBe("src/a.ts");
  });
});
