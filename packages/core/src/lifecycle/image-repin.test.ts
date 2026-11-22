/**
 * #5457: `chant release images --repin` moves each pinned reference to the
 * digest its tag names now, against a registry fake that requires a login;
 * nothing reaches a real registry.
 */
import { afterAll, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedReferences, registryResolver, repinFiles, type ImageResolver } from "./image-repin";
import { runReleaseImagesRepin } from "../cli/handlers/release";
import type { CommandContext } from "../cli/registry";
import { startFakeRegistry } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-repin-"));
  dirs.push(d);
  return d;
};
const OLD = `sha256:${"1".repeat(64)}`;
const NEW = `sha256:${"2".repeat(64)}`;
const fixed = (digests: Record<string, string>): ImageResolver & { asked: string[] } => {
  const asked: string[] = [];
  const r = (async (repository: string, tag: string) => {
    asked.push(`${repository}:${tag}`);
    const d = digests[`${repository}:${tag}`];
    if (!d) throw new Error(`${repository}:${tag} is not there`);
    return d;
  }) as ImageResolver & { asked: string[] };
  r.asked = asked;
  return r;
};

describe("pinnedReferences", () => {
  test("finds name:tag@digest anywhere and IMAGE_PINS rows, and leaves a digest with no tag or a tag with no digest", () => {
    const text = [`ARG BASE=node:22@${OLD}`, `FROM \${BASE} AS build`, `FROM ghcr.io/acme/base:1.2@${OLD}`, `FROM localhost:5000/tools:v3@${OLD}`, `FROM alpine@${OLD}`, "FROM debian:12", `const p = pin("tonistiigi/binfmt", "qemu-v10.2.3", "${OLD}");`].join("\n");
    expect(pinnedReferences(text).map((r) => [r.line, r.repository, r.tag])).toEqual([
      [1, "node", "22"],
      [3, "ghcr.io/acme/base", "1.2"],
      [4, "localhost:5000/tools", "v3"],
      [7, "tonistiigi/binfmt", "qemu-v10.2.3"],
    ]);
  });

  test("finds every row of chant's IMAGE_PINS and CI_BASE_IMAGES", () => {
    const pins = pinnedReferences(readFileSync(join(__dirname, "..", "image-pins.ts"), "utf-8"));
    expect(pins.map((p) => p.repository)).toContain("tonistiigi/binfmt");
    const base = pinnedReferences(readFileSync(join(__dirname, "..", "ci-image.ts"), "utf-8")).map((p) => `${p.repository}:${p.tag}`);
    expect(base).toEqual(expect.arrayContaining(["node:22-bookworm-slim", "debian:bookworm-slim"]));
  });
});

describe("repinFiles", () => {
  test("rewrites a stale digest in place, keeping the tag, and asks once per tag", async () => {
    const text = `FROM node:22@${OLD} AS build\nRUN true\nFROM node:22@${OLD}\nFROM debian:12-slim@${NEW}\n`;
    const resolver = fixed({ "node:22": NEW, "debian:12-slim": NEW });
    const r = await repinFiles([{ path: "Dockerfile", text }], resolver);
    expect(r.files[0]).toEqual({ path: "Dockerfile", text: `FROM node:22@${NEW} AS build\nRUN true\nFROM node:22@${NEW}\nFROM debian:12-slim@${NEW}\n`, changed: true });
    expect(r.moved).toEqual([
      { file: "Dockerfile", line: 1, reference: "node:22", from: OLD, to: NEW },
      { file: "Dockerfile", line: 3, reference: "node:22", from: OLD, to: NEW },
    ]);
    expect(r.unchanged).toBe(1);
    expect(resolver.asked.sort()).toEqual(["debian:12-slim", "node:22"]);
  });

  test("is a no-op when nothing moved, and leaves a tag it can't resolve", async () => {
    const text = `FROM node:22@${NEW}\nFROM gone:1@${OLD}\n`;
    const r = await repinFiles([{ path: "Dockerfile", text }], fixed({ "node:22": NEW }));
    expect(r.files[0]!.changed).toBe(false);
    expect(r.moved).toEqual([]);
    expect(r.failed).toEqual([{ file: "Dockerfile", line: 2, reference: "gone:1", reason: "gone:1 is not there" }]);
  });

  test("moves a reference to any image name under a registry, as a base: { registry } product records it", async () => {
    const ref = (d: string) => `  node: "cgr.dev/example.com/custom-node:22-dev@${d}",\n  wolfiBase: "cgr.dev/example.com/custom-base:latest@${d}",\n`;
    const resolver = fixed({ "cgr.dev/example.com/custom-node:22-dev": NEW, "cgr.dev/example.com/custom-base:latest": NEW });
    const r = await repinFiles([{ path: "image.ts", text: ref(OLD) }], resolver);
    expect(r.files[0]!.text).toBe(ref(NEW));
    expect(r.moved.map((m) => m.reference)).toEqual(["cgr.dev/example.com/custom-node:22-dev", "cgr.dev/example.com/custom-base:latest"]);
  });

  test("moves an IMAGE_PINS row", async () => {
    const text = `  binfmt: pin("tonistiigi/binfmt", "qemu-v10.2.3", "${OLD}"),\n`;
    const r = await repinFiles([{ path: "image-pins.ts", text }], fixed({ "tonistiigi/binfmt:qemu-v10.2.3": NEW }));
    expect(r.files[0]!.text).toBe(`  binfmt: pin("tonistiigi/binfmt", "qemu-v10.2.3", "${NEW}"),\n`);
  });
});

describe("registryResolver", () => {
  test("reads the index digest a tag names, logging in with a pull-only token", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-repin", token: "tok-repin" });
    try {
      const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] }));
      reg.manifests.set("22", { name: "library/node", type: "application/vnd.oci.image.index.v1+json", bytes: index });
      const resolve = registryResolver({ OCI_USERNAME: "robot", OCI_PASSWORD: "pw-repin" });
      expect(await resolve(`${reg.host}/library/node`, "22")).toBe(`sha256:${createHash("sha256").update(index).digest("hex")}`);
      expect(reg.requests.some((r) => r.path === "/token")).toBe(true);
      await expect(resolve(`${reg.host}/library/node`, "23")).rejects.toThrow(/not in/);
    } finally {
      await reg.close();
    }
  });
});

describe("chant release images --repin", () => {
  const run = async (cwd: string, args: Partial<CommandContext["args"]>, resolver: ImageResolver) => {
    const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((l: unknown) => void out.push(String(l)));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await runReleaseImagesRepin({ args: { repin: true, ...args } } as CommandContext, resolver);
      return { code, out };
    } finally {
      spy.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
  };

  test("rewrites the files given, prints what moved, and with --check writes nothing and exits 1", async () => {
    const dir = temp();
    writeFileSync(join(dir, "Dockerfile"), `FROM node:22@${OLD}\n`);
    const resolver = fixed({ "node:22": NEW });
    const checked = await run(dir, { positionals: ["images", "Dockerfile"], check: true }, resolver);
    expect(checked.code).toBe(1);
    expect(checked.out[0]).toBe(`would move Dockerfile:1 node:22 ${OLD} -> ${NEW}`);
    expect(readFileSync(join(dir, "Dockerfile"), "utf-8")).toBe(`FROM node:22@${OLD}\n`);

    const moved = await run(dir, { positionals: ["images", "Dockerfile"] }, resolver);
    expect(moved.code).toBe(0);
    expect(readFileSync(join(dir, "Dockerfile"), "utf-8")).toBe(`FROM node:22@${NEW}\n`);

    const again = await run(dir, { positionals: ["images", "Dockerfile"], json: true }, resolver);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out[0]!)).toEqual({ moved: [], unchanged: 1, failed: [], written: [] });
  });
});
