/** #4657: a cut with --at builds the images in the commit's own checkout; the archives are put back where release.images names them. */
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyImageArchives } from "./release";

describe("copyImageArchives", () => {
  test("a tar archive and a layout directory land at the same paths in the caller's directory; a missing one is skipped", () => {
    const from = mkdtempSync(join(tmpdir(), "chant-cut-from-"));
    const to = mkdtempSync(join(tmpdir(), "chant-cut-to-"));
    mkdirSync(join(from, "dist/images"), { recursive: true });
    writeFileSync(join(from, "dist/images/tofu.tar"), "tar bytes");
    mkdirSync(join(from, "out/layout/blobs/sha256"), { recursive: true });
    writeFileSync(join(from, "out/layout/index.json"), "{}");
    copyImageArchives([{ archive: "dist/images/tofu.tar" }, { archive: "out/layout" }, { archive: "dist/images/none.tar" }], from, to);
    expect(readFileSync(join(to, "dist/images/tofu.tar"), "utf8")).toBe("tar bytes");
    expect(readFileSync(join(to, "out/layout/index.json"), "utf8")).toBe("{}");
    expect(existsSync(join(to, "dist/images/none.tar"))).toBe(false);
  });
});
