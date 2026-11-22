/**
 * #5457: `chant release images --repin` moves each pinned reference to the
 * digest its tag names now, against a registry fake that requires a login;
 * nothing reaches a real registry. #5445: it moves Wolfi package versions
 * against fixture indexes; nothing reads Wolfi's live index.
 */
import { afterAll, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  apkIndexArchiveText,
  apkPinnedReferences,
  compareApkVersions,
  newestCommonApkVersion,
  parseApkIndex,
  pinnedReferences,
  registryResolver,
  repinFiles,
  wolfiIndexUrl,
  wolfiResolver,
  type ApkResolver,
  type ImageResolver,
} from "./image-repin";
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

/** One tar member, as apk's index archive holds it. */
const tarMember = (name: string, body: string): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf-8");
  header.write("0000644\0", 100);
  header.write(`${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  data.write(body, 0, "utf-8");
  return Buffer.concat([header, data]);
};
/** An APKINDEX.tar.gz as Wolfi serves it: a signature member with no end blocks, then the index, each its own gzip stream. */
const indexArchive = (records: Array<[string, string]>): Uint8Array =>
  new Uint8Array(
    Buffer.concat([
      gzipSync(tarMember(".SIGN.RSA256.wolfi-signing.rsa.pub", "signature")),
      gzipSync(Buffer.concat([tarMember("DESCRIPTION", ""), tarMember("APKINDEX", records.map(([p, v]) => `C:Q1x=\nP:${p}\nV:${v}\nA:x\nD:so:libc.so.6\n`).join("\n") + "\n"), Buffer.alloc(1024)])),
    ]),
  );
const fixedApk = (versions: Record<string, string>): ApkResolver & { asked: string[] } => {
  const asked: string[] = [];
  const r = (async (name: string) => {
    asked.push(name);
    const v = versions[name];
    if (!v) throw new Error(`no ${name} in the index`);
    return v;
  }) as ApkResolver & { asked: string[] };
  r.asked = asked;
  return r;
};

describe("apk versions (#5445)", () => {
  test("compareApkVersions orders versions as apk does for the ones Wolfi publishes", () => {
    const sorted = ["2.56.1-r1", "2.56.0-r3", "2.56.1-r0", "2.9.0-r0", "2.56-r9", "10.6_p1-r0", "10.6_p2-r0", "10.6-r0", "10.6_rc1-r0", "2026f-r1", "2026e-r0", "2026-r0", "713-r0", "712-r1"].sort(compareApkVersions);
    expect(sorted).toEqual(["2.9.0-r0", "2.56-r9", "2.56.0-r3", "2.56.1-r0", "2.56.1-r1", "10.6_rc1-r0", "10.6-r0", "10.6_p1-r0", "10.6_p2-r0", "712-r1", "713-r0", "2026-r0", "2026e-r0", "2026f-r1"]);
    expect(compareApkVersions("1.0-r0", "1.0-r0")).toBe(0);
  });

  test("reads the index out of Wolfi's archive and picks the newest version every architecture lists", () => {
    const x86 = parseApkIndex(apkIndexArchiveText(indexArchive([["git", "2.56.0-r3"], ["git", "2.56.1-r0"], ["git", "2.56.1-r1"], ["curl", "8.23.0-r4"]])));
    const arm = parseApkIndex(apkIndexArchiveText(indexArchive([["git", "2.56.0-r3"], ["git", "2.56.1-r0"], ["curl", "8.23.0-r4"]])));
    expect(x86.get("git")).toEqual(["2.56.0-r3", "2.56.1-r0", "2.56.1-r1"]);
    // r1 is built for x86_64 only so far, so one apk add line for both takes r0.
    expect(newestCommonApkVersion([x86, arm], "git")).toBe("2.56.1-r0");
    expect(newestCommonApkVersion([x86, arm], "curl")).toBe("8.23.0-r4");
    expect(newestCommonApkVersion([x86, arm], "gone")).toBeUndefined();
  });

  test("wolfiResolver reads each architecture's index once, from Wolfi's URLs", async () => {
    const fetched: string[] = [];
    const resolve = wolfiResolver(async (url) => {
      fetched.push(url);
      return indexArchive(url.includes("x86_64") ? [["jq", "1.8.2-r5"], ["jq", "1.8.2-r6"]] : [["jq", "1.8.2-r5"]]);
    });
    expect(await resolve("jq")).toBe("1.8.2-r5");
    await expect(resolve("gone")).rejects.toThrow(/no version of gone for both x86_64 and aarch64/);
    expect(fetched.sort()).toEqual([wolfiIndexUrl("aarch64"), wolfiIndexUrl("x86_64")]);
    expect(wolfiIndexUrl("x86_64")).toBe("https://packages.wolfi.dev/os/x86_64/APKINDEX.tar.gz");
  });

  test("apkPinnedReferences finds WOLFI_PACKAGE_PINS rows and apk:<name>=<version> entries, and nothing in a rendered apk add line", () => {
    const text = [
      `  apk("git", "2.56.1-r0", "2026-11-01"),`,
      `  packages: ["openssh-client", "apk:python-3.13=3.13.9-r0", "apk:jq", "apt:python3"],`,
      `RUN apk add --no-cache git=2.56.1-r0 ca-certificates=20261020-r0 || { echo "move an apk:<name>=<version> entry" >&2; exit 1; }`,
    ].join("\n");
    const refs = apkPinnedReferences(text);
    expect(refs.map((r) => [r.line, r.name, r.version, r.date?.value])).toEqual([
      [1, "git", "2.56.1-r0", "2026-11-01"],
      [2, "python-3.13", "3.13.9-r0", undefined],
    ]);
    expect(text.slice(refs[0]!.at, refs[0]!.at + refs[0]!.version.length)).toBe("2.56.1-r0");
    expect(text.slice(refs[0]!.date!.at, refs[0]!.date!.at + 10)).toBe("2026-11-01");
    expect(text.slice(refs[1]!.at, refs[1]!.at + refs[1]!.version.length)).toBe("3.13.9-r0");
  });

  test("finds every row of chant's WOLFI_PACKAGE_PINS", () => {
    const rows = apkPinnedReferences(readFileSync(join(__dirname, "..", "image-pins.ts"), "utf-8"));
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["git", "ca-certificates", "curl", "unzip", "openssh-client"]));
    expect(rows.every((r) => r.date !== undefined)).toBe(true);
  });

  test("repinFiles moves a row's version and its date, a product's entry, and an image digest in one file, asking once per package", async () => {
    const text = [`  binfmt: pin("tonistiigi/binfmt", "qemu-v10.2.3", "${OLD}"),`, `  apk("git", "2.56.1-r0", "2026-11-01"),`, `  apk("jq", "1.8.2-r5", "2026-11-01"),`, `  packages: ["apk:git=2.56.1-r0"],`, ""].join("\n");
    const apk = fixedApk({ git: "2.56.1-r1", jq: "1.8.2-r5" });
    const r = await repinFiles([{ path: "pins.ts", text }], fixed({ "tonistiigi/binfmt:qemu-v10.2.3": NEW }), { apk, today: "2026-11-21" });
    expect(r.files[0]!.text).toBe(
      [`  binfmt: pin("tonistiigi/binfmt", "qemu-v10.2.3", "${NEW}"),`, `  apk("git", "2.56.1-r1", "2026-11-21"),`, `  apk("jq", "1.8.2-r5", "2026-11-01"),`, `  packages: ["apk:git=2.56.1-r1"],`, ""].join("\n"),
    );
    expect(r.moved).toEqual([
      { file: "pins.ts", line: 1, reference: "tonistiigi/binfmt:qemu-v10.2.3", from: OLD, to: NEW },
      { file: "pins.ts", line: 2, reference: "apk:git", from: "2.56.1-r0", to: "2.56.1-r1" },
      { file: "pins.ts", line: 4, reference: "apk:git", from: "2.56.1-r0", to: "2.56.1-r1" },
    ]);
    expect(r.unchanged).toBe(1);
    expect(apk.asked.sort()).toEqual(["git", "jq"]);
  });

  test("a package the index lacks, or no index at all, leaves the version and is reported", async () => {
    const text = `  apk("gone", "1.0-r0", "2026-11-01"),\n`;
    const r = await repinFiles([{ path: "pins.ts", text }], fixed({}), { apk: fixedApk({}) });
    expect(r.files[0]!.changed).toBe(false);
    expect(r.failed).toEqual([{ file: "pins.ts", line: 1, reference: "apk:gone", reason: "no gone in the index" }]);
    const none = await repinFiles([{ path: "pins.ts", text }], fixed({}));
    expect(none.failed[0]!.reason).toMatch(/no package index/);
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
  const run = async (cwd: string, args: Partial<CommandContext["args"]>, resolver: ImageResolver, apk?: ApkResolver) => {
    const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((l: unknown) => void out.push(String(l)));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await runReleaseImagesRepin({ args: { repin: true, ...args } } as CommandContext, resolver, apk);
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

  test("moves a product's apk:<name>=<version> entry in the file given, against the package index", async () => {
    const dir = temp();
    writeFileSync(join(dir, "image.ts"), `export const packages = ["openssh-client", "apk:python-3.13=3.13.9-r0"];\n`);
    const moved = await run(dir, { positionals: ["images", "image.ts"] }, fixed({}), fixedApk({ "python-3.13": "3.13.9-r1" }));
    expect(moved.code).toBe(0);
    expect(moved.out[0]).toBe("moved image.ts:1 apk:python-3.13 3.13.9-r0 -> 3.13.9-r1");
    expect(readFileSync(join(dir, "image.ts"), "utf-8")).toBe(`export const packages = ["openssh-client", "apk:python-3.13=3.13.9-r1"];\n`);
  });
});
