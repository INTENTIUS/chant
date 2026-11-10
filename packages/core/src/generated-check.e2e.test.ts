import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #4909 end to end: `chant dev generated-check` through the real CLI, on a
 * product whose release workflow `chant release workflow` writes, the render
 * terragucci's `just ci-check` had to strip `--output` from with sed; and
 * `chant dev local-image` on a pinned and a local chant.
 */

const here = dirname(fileURLToPath(import.meta.url));
const mainTs = resolve(here, "cli/main.ts");
const tsxLoader = pathToFileURL(resolve(here, "../../../node_modules/tsx/dist/loader.mjs")).href;
const chantCommand = `${JSON.stringify(process.execPath)} --import ${tsxLoader} ${JSON.stringify(mainTs)}`;

const write = (file: string, body: string | object) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
};

const chant = (cwd: string, ...args: string[]) => spawnSync(process.execPath, ["--import", tsxLoader, mainTs, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 110_000 });

/** A git repository holding a chant workspace with a committed release workflow. */
function product(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-4909-e2e-")));
  write(join(dir, "chant.workspace.json"), { name: "product", schema: 1, members: [] });
  write(join(dir, "chant.config.json"), { lexicons: [] });
  write(join(dir, "package.json"), {
    name: "product",
    private: true,
    chantGenerated: {
      regenerate: "chant release workflow --forge github",
      // #4950: no --output; under the check the default file goes to the render tree.
      renders: [{ name: "release", run: `${chantCommand} release workflow --forge github`, files: [".github/workflows/chant-release.yml"] }],
    },
  });
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
  return dir;
}

describe("chant dev generated-check (#4909)", () => {
  it("passes on the committed release workflow, then fails a hand edit and leaves the render tree", () => {
    const dir = product();
    const written = chant(dir, "release", "workflow", "--forge", "github");
    expect(written.status).toBe(0);
    const committed = readFileSync(join(dir, ".github/workflows/chant-release.yml"), "utf8");
    expect(committed.split("\n")[0]).not.toContain("--output");

    const ok = chant(dir, "dev", "generated-check", "--json");
    expect(ok.status).toBe(0);
    const result = JSON.parse(ok.stdout);
    expect(result.matched).toEqual([".github/workflows/chant-release.yml"]);
    // The check rendered beside the product and wrote nothing in it.
    expect(readFileSync(join(dir, ".github/workflows/chant-release.yml"), "utf8")).toBe(committed);
    expect(readFileSync(join(result.out, ".github/workflows/chant-release.yml"), "utf8")).toBe(committed);

    writeFileSync(join(dir, ".github/workflows/chant-release.yml"), committed.replace("name: chant release", "name: hand edited"));
    const bad = chant(dir, "dev", "generated-check");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(".github/workflows/chant-release.yml is not what 'release' renders. Run 'chant release workflow --forge github' and commit the result.");
    expect(bad.stderr).toContain("+ name: chant release");
    expect(bad.stderr).toMatch(/the renders are in .*chant-generated-/);
  }, 120_000);

  it("writes a module's file-text export in place with dev render, then checks it as a module render (#4950)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-4950-e2e-")));
    write(join(dir, "src/images.ts"), `export const dockerfiles = (): Record<string, string> => ({ "images/a/Dockerfile": "FROM a\\n" });\n`);
    write(join(dir, "package.json"), { name: "product", private: true, chantGenerated: { regenerate: "chant dev render src/images.ts dockerfiles", renders: [{ name: "images", module: "src/images.ts", export: "dockerfiles" }] } });
    const missing = chant(dir, "dev", "generated-check");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("images/a/Dockerfile is what 'images' renders, but it is not committed.");

    const rendered = chant(dir, "dev", "render", "src/images.ts", "dockerfiles");
    expect(rendered.status).toBe(0);
    expect(readFileSync(join(dir, "images/a/Dockerfile"), "utf8")).toBe("FROM a\n");
    const ok = chant(dir, "dev", "generated-check", "--json");
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).matched).toEqual(["images/a/Dockerfile"]);

    const usage = chant(dir, "dev", "render", "src/images.ts");
    expect(usage.status).toBe(2);
  }, 120_000);

  it("refuses a product with no chantGenerated", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-4909-e2e-none-")));
    write(join(dir, "package.json"), { name: "none" });
    const r = chant(dir, "dev", "generated-check");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("declares no chantGenerated");
  }, 60_000);
});

describe("chant dev local-image (#4909)", () => {
  it("names the pin, then the local build and its build context, and refuses a missing tarball", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-4909-e2e-image-")));
    write(join(dir, "package.json"), { name: "product", private: true, devDependencies: { "@intentius/chant": "1.2.3" } });
    write(join(dir, "node_modules/@intentius/chant/package.json"), { name: "@intentius/chant", version: "1.2.3" });
    const pinned = chant(dir, "dev", "local-image");
    expect(pinned.status).toBe(0);
    expect(pinned.stdout.trim()).toBe("1.2.3");

    write(join(dir, "node_modules/@intentius/chant/package.json"), { name: "@intentius/chant", version: "1.3.0", chantLocal: { commit: "abc123", dir: "/chant" } });
    write(join(dir, ".chant-local/commit"), "abc123\n");
    write(join(dir, ".chant-local/intentius-chant.tgz"), "tgz");
    const local = chant(dir, "dev", "local-image", "--json");
    expect(local.status).toBe(0);
    expect(JSON.parse(local.stdout).args).toEqual(["--build-context", `chant-local=${join(dir, ".chant-local")}`, "--build-arg", "CHANT_VERSION=local-abc123"]);

    const missing = chant(dir, "dev", "local-image", "--with", "@intentius/chant-lexicon-fountain");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no tarball for @intentius/chant-lexicon-fountain; run chant dev local again with --with @intentius/chant-lexicon-fountain");
  }, 60_000);
});
