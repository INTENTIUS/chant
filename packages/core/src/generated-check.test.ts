import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGenerated, committedPathOf, diffLines, GENERATED_OUT_ENV, GENERATED_ROOT_ENV, isRenderPath, readGeneratedCheckConfig, renderPathOf, type GeneratedCheckConfig } from "./generated-check";

/** #4909: a product's generated files checked by chant instead of terragucci's `just ci-check` and plywood's `--check` scripts. */

const write = (file: string, body: string | object) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
};

/** A product whose committed files are what its renders write: a workflow, two Dockerfiles by pattern, and a script that checks itself. */
function product(): { dir: string; config: GeneratedCheckConfig } {
  const dir = mkdtempSync(join(tmpdir(), "chant-4909-product-"));
  write(join(dir, ".github/workflows/ci.yml"), "name: ci\non: push\n");
  write(join(dir, "images/Dockerfile.tofu"), "FROM tofu\n");
  write(join(dir, "images/Dockerfile.node"), "FROM node\n");
  write(join(dir, "images/images.ts"), "// the source\n");
  const config: GeneratedCheckConfig = {
    regenerate: "just ci",
    renders: [
      { name: "ci", run: "mkdir -p {out}/.github/workflows && printf 'name: ci\\non: push\\n' > {out}/.github/workflows/ci.yml", files: [".github/workflows/ci.yml"] },
      { name: "images", run: 'mkdir -p "$CHANT_GENERATED_OUT/images" && printf "FROM tofu\\n" > "$CHANT_GENERATED_OUT/images/Dockerfile.tofu" && printf "FROM node\\n" > "$CHANT_GENERATED_OUT/images/Dockerfile.node"', files: ["images/Dockerfile.*"] },
      { name: "dashboards", run: "true" },
    ],
  };
  write(join(dir, "package.json"), { name: "product", private: true, chantGenerated: config });
  return { dir, config };
}

describe("checkGenerated (#4909)", () => {
  it("passes when every committed file is its render, and leaves the render tree", async () => {
    const { dir, config } = product();
    const r = await checkGenerated(dir, config);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.matched).toEqual([".github/workflows/ci.yml", "images/Dockerfile.node", "images/Dockerfile.tofu"]);
    expect(r.out).toContain("chant-generated-");
    expect(readFileSync(join(r.out, "images/Dockerfile.tofu"), "utf8")).toBe("FROM tofu\n");
  });

  it("fails a hand edit with a diff and the regenerate command, and a file on one side only", async () => {
    const { dir, config } = product();
    write(join(dir, ".github/workflows/ci.yml"), "name: ci\non: pull_request\n");
    write(join(dir, "images/Dockerfile.old"), "FROM old\n");
    const r = await checkGenerated(dir, config);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain(".github/workflows/ci.yml is not what 'ci' renders. Run 'just ci' and commit the result.");
    expect(r.problems[0]).toContain("- on: pull_request");
    expect(r.problems[0]).toContain("+ on: push");
    expect(r.problems[1]).toBe("images/Dockerfile.old is committed, but 'images' no longer renders it. Run 'just ci' and commit the result.");
    expect(existsSync(r.out)).toBe(true);
  });

  it("fails a render that exits non-zero or writes nothing, and a name it does not have", async () => {
    const { dir } = product();
    const r = await checkGenerated(dir, {
      renders: [
        { name: "broken", run: "echo nope >&2; exit 3", files: ["a.yml"] },
        { name: "silent", run: "true", files: [".github/workflows/ci.yml"] },
      ],
    }, { only: ["broken", "silent", "absent"] });
    expect(r.problems).toEqual([
      "chantGenerated has no render named 'absent'",
      "render 'broken' exited 3: echo nope >&2; exit 3\n    nope",
      "render 'silent' wrote no .github/workflows/ci.yml under the render tree",
    ]);
  });

  it("reads chantGenerated and refuses a malformed one", () => {
    const { dir, config } = product();
    expect(readGeneratedCheckConfig(dir)).toEqual(config);
    write(join(dir, "package.json"), { chantGenerated: { renders: [{ name: "x", run: "true", files: ["../outside"] }] } });
    expect(() => readGeneratedCheckConfig(dir)).toThrow("must be paths inside the product");
    write(join(dir, "package.json"), { name: "none" });
    expect(readGeneratedCheckConfig(dir)).toBeUndefined();
  });

  it("diffs from the first line that differs", () => {
    expect(diffLines("a\nb\nc\nd\n", "a\nb\nX\nd\n")).toEqual(["@@ line 3 @@", "  a", "  b", "- c", "+ X"]);
  });
});

describe("chant's writers under a check (#4909)", () => {
  afterEach(() => {
    delete process.env[GENERATED_OUT_ENV];
    delete process.env[GENERATED_ROOT_ENV];
  });

  it("move a product path into the render tree and name a render path as the committed one", () => {
    expect(renderPathOf("/p/.github/workflows/a.yml")).toBe("/p/.github/workflows/a.yml");
    process.env[GENERATED_OUT_ENV] = "/t/out";
    process.env[GENERATED_ROOT_ENV] = "/p";
    expect(renderPathOf("/p/.github/workflows/a.yml")).toBe("/t/out/.github/workflows/a.yml");
    expect(renderPathOf("/elsewhere/a.yml")).toBe("/elsewhere/a.yml");
    expect(renderPathOf("/t/out/a.yml")).toBe("/t/out/a.yml");
    expect(committedPathOf("/t/out/.github/workflows/a.yml")).toBe("/p/.github/workflows/a.yml");
    expect(committedPathOf("/p/a.yml")).toBe("/p/a.yml");
    expect(isRenderPath("/t/out/x")).toBe(true);
    expect(isRenderPath("/t/outside/x")).toBe(false);
  });
});
