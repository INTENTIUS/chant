import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadKindRegistry } from "./kinds";
import { checkPinIntegrity, integrityOf, parseIntegrity, pinnedFiles } from "./pin-integrity";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function dir(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-pin-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const tf = { name: "terraform", description: "a Terraform root module", precedence: 400, probe: { anyFile: ["main.tf"] } };
const plugin = (): Record<string, string> => ({
  "plugins/tf/package.json": JSON.stringify({ name: "tf", exports: { "./workspace-kinds": "./k.json" } }),
  "plugins/tf/k.json": JSON.stringify({ schema: 1, kinds: [tf] }),
});

describe("integrityOf", () => {
  test("a file is its bytes' SRI digest", () => {
    const root = dir({ "a.txt": "hello\n" });
    const expected = `sha256-${createHash("sha256").update("hello\n").digest("base64")}`;
    expect(integrityOf(join(root, "a.txt"))).toEqual({ integrity: expected, files: 1 });
  });

  test("a directory is the digest of a manifest of each file's own digest and path, sorted by path", () => {
    const root = dir({ "d/b.txt": "B", "d/a/z.txt": "Z" });
    const h = (s: string) => createHash("sha256").update(s).digest("hex");
    const manifest = `${h("Z")} a/z.txt\n${h("B")} b.txt\n`;
    expect(integrityOf(join(root, "d"))).toEqual({
      integrity: `sha256-${createHash("sha256").update(manifest).digest("base64")}`,
      files: 2,
    });
  });

  test("it does not depend on the order files were written, and it follows a changed byte, a rename and an added file", () => {
    const base = integrityOf(join(dir({ "d/a": "1", "d/b": "2" }), "d")).integrity;
    expect(integrityOf(join(dir({ "d/b": "2", "d/a": "1" }), "d")).integrity).toBe(base);
    expect(integrityOf(join(dir({ "d/a": "1", "d/b": "3" }), "d")).integrity).not.toBe(base);
    expect(integrityOf(join(dir({ "d/a": "1", "d/c": "2" }), "d")).integrity).not.toBe(base);
    expect(integrityOf(join(dir({ "d/a": "1", "d/b": "2", "d/e": "" }), "d")).integrity).not.toBe(base);
  });

  test("node_modules and .git are left out, and a symbolic link is refused", () => {
    const root = dir({ "d/a": "1", "d/node_modules/x/index.js": "x", "d/.git/HEAD": "ref" });
    expect(pinnedFiles(join(root, "d"))).toEqual(["a"]);
    symlinkSync("/etc/hosts", join(root, "d", "link"));
    expect(() => integrityOf(join(root, "d"))).toThrow(/link is a symbolic link/);
  });

  test("sha384 and sha512 are taken with that algorithm", () => {
    const root = dir({ "d/a": "1" });
    expect(integrityOf(join(root, "d"), "sha512").integrity).toMatch(/^sha512-/);
    expect(integrityOf(join(root, "d"), "sha384").integrity).toMatch(/^sha384-/);
  });
});

describe("parseIntegrity", () => {
  test("takes the three SRI algorithms and nothing else", () => {
    expect(parseIntegrity("sha256-AAAA")).toEqual({ algorithm: "sha256", digest: "AAAA" });
    expect(parseIntegrity("md5-AAAA")).toBeUndefined();
    expect(parseIntegrity("sha256:AAAA")).toBeUndefined();
  });
});

describe("a path pin's integrity when kinds are loaded (#2547)", () => {
  test("a matching integrity loads the plugin's kinds", () => {
    const root = dir(plugin());
    const { integrity } = integrityOf(join(root, "plugins/tf"));
    const { registry, problems } = loadKindRegistry([{ package: null, version: null, path: "plugins/tf", integrity }], root);
    expect(problems).toEqual([]);
    expect(registry.get("terraform")?.source).toBe("plugins/tf");
  });

  test("a changed plugin is refused with the expected and actual hash, and none of its kinds load", () => {
    const root = dir(plugin());
    const { integrity } = integrityOf(join(root, "plugins/tf"));
    writeFileSync(join(root, "plugins/tf/k.json"), JSON.stringify({ schema: 1, kinds: [{ ...tf, name: "evil" }] }));
    const { registry, problems } = loadKindRegistry([{ package: null, version: null, path: "plugins/tf", integrity }], root);
    expect(registry.get("evil")).toBeUndefined();
    expect(registry.get("terraform")).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0].pin).toBe(0);
    expect(problems[0].message).toContain("plugins/tf: integrity mismatch, so nothing is read from it");
    expect(problems[0].message).toContain(`The pin says ${integrity} and the plugin hashes to sha256-`);
    expect(problems[0].message).toContain("chant workspace pin plugins/tf");
  });

  test("an added file is a mismatch too", () => {
    const root = dir(plugin());
    const { integrity } = integrityOf(join(root, "plugins/tf"));
    writeFileSync(join(root, "plugins/tf/extra.js"), "x");
    const checked = checkPinIntegrity(join(root, "plugins/tf"), integrity, "plugins/tf");
    expect(checked.ok).toBe(false);
  });

  test("a pin with no integrity loads as before", () => {
    const root = dir(plugin());
    const { registry, problems } = loadKindRegistry([{ package: null, version: null, path: "plugins/tf", integrity: null }], root);
    expect(problems).toEqual([]);
    expect(registry.get("terraform")).toBeDefined();
  });

  test("a missing plugin and a malformed integrity are problems, not throws", () => {
    const root = dir(plugin());
    const missing = loadKindRegistry([{ package: null, version: null, path: "plugins/none", integrity: "sha256-AAAA" }], root);
    expect(missing.problems[0].message).toMatch(/can't check its integrity, it does not exist/);
    const bad = checkPinIntegrity(join(root, "plugins/tf"), "nope", "plugins/tf");
    expect(bad).toEqual({ ok: false, message: expect.stringContaining("is not sha256-, sha384- or sha512-") });
  });
});
