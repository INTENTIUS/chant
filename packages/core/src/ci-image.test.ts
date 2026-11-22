import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { IMAGE_PINS, imageRef, WOLFI_PACKAGE_PINS } from "./image-pins";
import { NEXT_RELEASE } from "./release-floors";
import {
  CI_BASE_IMAGES,
  CI_IMAGE_BASE_FLOOR,
  CI_IMAGE_CHAINGUARD_USER,
  CI_IMAGE_PACKAGE_NAMES,
  CI_IMAGE_DOCKER_STAGES_FLOOR,
  CI_IMAGE_FLOOR,
  CI_IMAGE_NON_ROOT_FLOOR,
  CI_TOOL_NODE_DOWNLOAD_FLOOR,
  CI_TOOL_DOCKER_ARCH,
  CI_TOOL_SHA256,
  CI_TOOLS,
  checksumFor,
  ciImageBase,
  ciImagePackages,
  ciToolBin,
  ciToolFetchScript,
  ciToolInstallLine,
  ciToolRelease,
  ciToolSha256,
  derivedImageDockerfile,
  dockerfileText,
  installCiTool,
  productImageDockerfile,
  productImageStages,
  unzipEntry,
  type CiTool,
} from "./ci-image";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ci-image-"));
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** A ustar archive of `files`, gzipped, as a release's `.tar.gz` holds them. */
function tarGz(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf-8");
    h.write("0000755\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    h.fill(" ", 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A zip of `files`, deflated, with a central directory, as a release's `.zip` holds them; `modes` gives an entry its Unix mode, as the AWS CLI's installer has. */
function zip(files: Record<string, string>, modes: Record<string, number> = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    if (modes[name] !== undefined) {
      // Made by Unix (3), with the mode in the external attributes' high half.
      central.writeUInt16LE((3 << 8) | 20, 4);
      central.writeUInt32LE(((0o100000 | modes[name]!) << 16) >>> 0, 38);
    }
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A download that serves `files` by URL and never reaches the network. */
function served(files: Record<string, Uint8Array | string>): { download: (url: string) => Promise<Uint8Array>; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    download: async (url) => {
      urls.push(url);
      const f = files[url];
      if (f === undefined) throw new Error(`${url}: HTTP 404`);
      return typeof f === "string" ? Buffer.from(f) : f;
    },
  };
}

/**
 * Runs a fetch script with a `curl` on PATH that serves files from a local
 * directory by the URL's last segment, so the real shell check runs against
 * fixtures and nothing reaches the network.
 */
function runShell(script: string, fixtures: Record<string, Uint8Array | string>, env: Record<string, string> = {}): { status: number; stderr: string; urls: string[] } {
  const dir = tmp();
  const serve = join(dir, "serve");
  const bin = join(dir, "bin");
  mkdirSync(serve);
  mkdirSync(bin);
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(serve, name), body);
  const log = join(dir, "urls");
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\n# curl -fsSLo <out> <url>\nprintf '%s\\n' "$3" >> "${log}"\nf="${serve}/$(basename "$3")"\n[ -f "$f" ] || { echo "curl: (22) 404 $3" >&2; exit 22; }\ncp "$f" "$2"\n`,
  );
  chmodSync(join(bin, "curl"), 0o755);
  const r = spawnSync("sh", ["-c", `set -e; ${script}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: "utf-8" });
  return { status: r.status ?? -1, stderr: r.stderr, urls: existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : [] };
}

/**
 * Runs a fetch script as a job with no curl and no unzip would (#4952):
 * both are on PATH as commands that fail, and node's `fetch` is replaced,
 * through `NODE_OPTIONS=--import`, by one that serves the fixtures by the
 * URL's last segment.
 */
function runNodeShell(script: string, fixtures: Record<string, Uint8Array | string>, env: Record<string, string> = {}): { status: number; stderr: string; urls: string[] } {
  const dir = tmp();
  const serve = join(dir, "serve");
  const bin = join(dir, "bin");
  mkdirSync(serve);
  mkdirSync(bin);
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(serve, name), body);
  const log = join(dir, "urls");
  for (const missing of ["curl", "unzip"]) {
    writeFileSync(join(bin, missing), `#!/bin/sh\necho "${missing}: not in this image" >&2\nexit 127\n`);
    chmodSync(join(bin, missing), 0o755);
  }
  const preload = join(dir, "fetch.mjs");
  writeFileSync(
    preload,
    [
      'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
      "globalThis.fetch = async (url) => {",
      `  appendFileSync(${JSON.stringify(log)}, String(url) + "\\n");`,
      `  const f = ${JSON.stringify(serve)} + "/" + String(url).split("/").pop();`,
      '  return existsSync(f) ? new Response(readFileSync(f)) : new Response("not found", { status: 404 });',
      "};",
    ].join("\n"),
  );
  const r = spawnSync("sh", ["-c", `set -e; ${script}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import ${preload}`, ...env }, encoding: "utf-8" });
  return { status: r.status ?? -1, stderr: r.stderr, urls: existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : [] };
}

describe("ciToolRelease", () => {
  test("names each release file and its checksums file per architecture", () => {
    expect(ciToolRelease("tofu", "1.13.1", "arm64")).toMatchObject({
      url: "https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_linux_arm64.tar.gz",
      checksumsUrl: "https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_SHA256SUMS",
      layout: "tar.gz",
      member: "tofu",
    });
    expect(ciToolRelease("terramate", "0.14.0", "amd64").asset).toBe("terramate_0.14.0_linux_x86_64.tar.gz");
    expect(ciToolRelease("infracost", "0.10.45", "amd64").checksumsUrl).toBe("https://github.com/infracost/infracost/releases/download/v0.10.45/infracost-linux-amd64.tar.gz.sha256");
    expect(ciToolRelease("pulumi", "3.272.0", "amd64").asset).toBe("pulumi-v3.272.0-linux-x64.tar.gz");
    expect(ciToolRelease("aws-cli", "2.22.0", "arm64")).toMatchObject({ url: "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-2.22.0.zip", bin: "aws", path: "v2/current/bin/aws" });
    expect(ciToolRelease("aws-cli", "2.22.0", "arm64").checksumsUrl).toBeUndefined();
    for (const tool of CI_TOOLS) expect(ciToolRelease(tool, "1.0.0", "amd64").url).toMatch(/^https:\/\//);
  });

  test("refuses a version that is not a release, and a tool chant does not know", () => {
    expect(() => ciToolRelease("tofu", "1.13; rm -rf /", "amd64")).toThrow(/not a release version/);
    expect(() => ciToolRelease("helm" as CiTool, "1.0.0", "amd64")).toThrow(/chant installs/);
  });

  test("the recorded sums are 64 hex digits for both architectures, and a caller's replace them", () => {
    for (const [k, v] of Object.entries(CI_TOOL_SHA256)) {
      expect(v, k).toMatch(/^[0-9a-f]{64}$/);
      expect(CI_TOOL_SHA256[k.replace(/-(amd64|arm64)$/, (_m, a) => (a === "amd64" ? "-arm64" : "-amd64"))], k).toBeDefined();
    }
    expect(ciToolSha256("tofu", "1.13.1").amd64).toBe(CI_TOOL_SHA256["tofu-1.13.1-linux-amd64"]);
    expect(ciToolSha256("tofu", "1.13.1", { arm64: "a".repeat(64) })).toEqual({ arm64: "a".repeat(64) });
    expect(() => ciToolSha256("tofu", "1.13.1", { amd64: "nothex" })).toThrow(/64 lower-case hex/);
  });

  test("CI_IMAGE_FLOOR is the release that shipped it, and #4908's and #4932's floors theirs", () => {
    expect(CI_IMAGE_FLOOR).toBe("0.124.86");
    expect(CI_IMAGE_NON_ROOT_FLOOR).toBe("0.124.88");
    expect(CI_IMAGE_DOCKER_STAGES_FLOOR).toBe("0.124.88");
    expect(CI_TOOL_NODE_DOWNLOAD_FLOOR).toBe("0.124.89");
    expect(CI_IMAGE_BASE_FLOOR).toBe(NEXT_RELEASE);
  });
});

describe("ciToolFetchScript against local fixtures", () => {
  const archive = tarGz({ tofu: "#!/bin/sh\necho tofu\n" });
  const sum = sha(archive);
  const sums = (s: string) => `${s}  tofu_1.13.1_linux_amd64.tar.gz\n${"0".repeat(64)}  tofu_1.13.1_linux_arm64.tar.gz\n`;
  const pin = { amd64: sum, arm64: "1".repeat(64) };

  test("installs a release whose checksums file and recorded sha256 both match", () => {
    const out = tmp();
    const script = ciToolFetchScript("tofu", "1.13.1", { dir: `${out}/tofu-1.13.1`, arch: CI_TOOL_DOCKER_ARCH, sha256: pin, requirePin: true });
    const r = runShell(script, { "tofu_1.13.1_linux_amd64.tar.gz": archive, "tofu_1.13.1_SHA256SUMS": sums(sum) }, { TARGETARCH: "amd64" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readFileSync(`${out}/tofu-1.13.1/tofu`, "utf-8")).toContain("echo tofu");
    expect(r.urls).toEqual([
      "https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_linux_amd64.tar.gz",
      "https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_SHA256SUMS",
    ]);
  });

  test("fails a tampered archive", () => {
    const out = tmp();
    const script = ciToolFetchScript("tofu", "1.13.1", { dir: `${out}/d`, arch: CI_TOOL_DOCKER_ARCH, sha256: pin });
    const tampered = tarGz({ tofu: "#!/bin/sh\necho evil\n" });
    // The checksums file still lists the real sum, so the archive fails sha256sum.
    const r = runShell(script, { "tofu_1.13.1_linux_amd64.tar.gz": tampered, "tofu_1.13.1_SHA256SUMS": sums(sum) }, { TARGETARCH: "amd64" });
    expect(r.status).not.toBe(0);
    expect(existsSync(`${out}/d/tofu`)).toBe(false);
  });

  test("fails a tampered checksums file that lists the tampered archive's sum", () => {
    const out = tmp();
    const script = ciToolFetchScript("tofu", "1.13.1", { dir: `${out}/d`, arch: CI_TOOL_DOCKER_ARCH, sha256: pin, checksumsUrl: '"$CHECKSUMS_URL"' });
    const tampered = tarGz({ tofu: "#!/bin/sh\necho evil\n" });
    const r = runShell(script, { "tofu_1.13.1_linux_amd64.tar.gz": tampered, "evil-sums": sums(sha(tampered)) }, { TARGETARCH: "amd64", CHECKSUMS_URL: "https://example.invalid/evil-sums" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`tofu 1.13.1: tofu_1.13.1_SHA256SUMS lists ${sha(tampered)} for tofu_1.13.1_linux_amd64.tar.gz; chant records ${sum}`);
    expect(r.urls[1]).toBe("https://example.invalid/evil-sums");
    expect(existsSync(`${out}/d/tofu`)).toBe(false);
  });

  test("fails an archive its checksums file does not list", () => {
    const script = ciToolFetchScript("tofu", "1.13.1", { dir: `${tmp()}/d`, arch: CI_TOOL_DOCKER_ARCH, sha256: pin });
    const r = runShell(script, { "tofu_1.13.1_linux_amd64.tar.gz": archive, "tofu_1.13.1_SHA256SUMS": "" }, { TARGETARCH: "amd64" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("tofu_1.13.1_linux_amd64.tar.gz is not in tofu_1.13.1_SHA256SUMS");
  });

  test("fails an architecture chant has no build for", () => {
    const script = ciToolFetchScript("tofu", "1.13.1", { dir: `${tmp()}/d`, arch: CI_TOOL_DOCKER_ARCH, sha256: pin });
    const r = runShell(script, {}, { TARGETARCH: "riscv64" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("chant fetches it for amd64 and arm64, not riscv64");
    expect(r.urls).toEqual([]);
  });

  test("a release with no checksums file installs on its recorded sha256 alone, and fails another file", () => {
    const binary = Buffer.from("#!/bin/sh\necho just\n");
    const archiveJust = tarGz({ just: binary.toString() });
    const out = tmp();
    // just publishes a checksums file from 1.35.0 (#4952), so an older release is checked on its recorded sha256.
    const script = ciToolFetchScript("just", "1.34.0", { dir: `${out}/d`, arch: CI_TOOL_DOCKER_ARCH, sha256: { amd64: sha(archiveJust), arm64: "2".repeat(64) } });
    expect(script).not.toContain("sums");
    expect(runShell(script, { "just-1.34.0-x86_64-unknown-linux-musl.tar.gz": archiveJust }, { TARGETARCH: "amd64" }).status).toBe(0);
    expect(readFileSync(`${out}/d/just`, "utf-8")).toContain("echo just");
    const r = runShell(script, { "just-1.34.0-aarch64-unknown-linux-musl.tar.gz": archiveJust }, { TARGETARCH: "arm64" });
    expect(r.status).not.toBe(0);
  });

  test("a bare binary, and a zip's member, install as the command", () => {
    const tg = Buffer.from("#!/bin/sh\necho terragrunt\n");
    const out = tmp();
    const s1 = ciToolFetchScript("terragrunt", "1.1.0", { dir: `${out}/tg`, arch: CI_TOOL_DOCKER_ARCH });
    expect(runShell(s1, { terragrunt_linux_arm64: tg, SHA256SUMS: `${sha(tg)} *terragrunt_linux_arm64\n` }, { TARGETARCH: "arm64" }).status).toBe(0);
    expect(readFileSync(`${out}/tg/terragrunt`, "utf-8")).toContain("echo terragrunt");

    const z = zip({ terraform: "#!/bin/sh\necho terraform\n", "LICENSE.txt": "x" });
    const s2 = ciToolFetchScript("terraform", "1.14.8", { dir: `${out}/tf`, arch: CI_TOOL_DOCKER_ARCH });
    const r = runShell(s2, { "terraform_1.14.8_linux_amd64.zip": z, "terraform_1.14.8_SHA256SUMS": `${sha(z)}  terraform_1.14.8_linux_amd64.zip\n` }, { TARGETARCH: "amd64" });
    expect(r.stderr).toBe("");
    expect(readFileSync(`${out}/tf/terraform`, "utf-8")).toContain("echo terraform");
  });

  test("a choudoufu checksums file names the file as ./<file>", () => {
    const a = tarGz({ choudoufu: "#!/bin/sh\n" });
    const out = tmp();
    const s = ciToolFetchScript("choudoufu", "0.31.0", { dir: `${out}/c`, arch: CI_TOOL_DOCKER_ARCH, sha256: { amd64: sha(a), arm64: "3".repeat(64) } });
    expect(runShell(s, { "choudoufu_v0.31.0_linux_amd64.tar.gz": a, SHA256SUMS: `${sha(a)}  ./choudoufu_v0.31.0_linux_amd64.tar.gz\n` }, { TARGETARCH: "amd64" }).status).toBe(0);
  });

  test("refuses, before any shell, a release that needs a recorded sha256 it lacks", () => {
    expect(() => ciToolFetchScript("just", "1.34.0", { dir: "/out/just" })).toThrow(/no recorded sha256 for just 1.34.0 on amd64 and arm64; just's release publishes no checksums file/);
    expect(() => ciToolFetchScript("terragrunt", "1.1.0", { dir: "/out/tg", requirePin: true })).toThrow(/no recorded sha256 for terragrunt 1.1.0/);
    expect(() => ciToolFetchScript("tofu", "1.13.1", { dir: "/out/x y" })).toThrow(/absolute path/);
  });
});

describe("ciToolInstallLine", () => {
  test("skips when the versioned directory holds the binary, else fetches, checks and links", () => {
    const line = ciToolInstallLine("choudoufu", "0.31.0");
    expect(line.startsWith('{ [ -x "/opt/chant/choudoufu-0.31.0/choudoufu" ] || (set -e; a="$(uname -m')).toBe(true);
    expect(line).toContain(CI_TOOL_SHA256["choudoufu-0.31.0-linux-amd64"]);
    expect(line.endsWith('ln -sf "/opt/chant/choudoufu-0.31.0/choudoufu" /usr/local/bin/choudoufu')).toBe(true);
    expect(ciToolInstallLine("tofu", "1.13.1", { link: false, root: "/opt/terragucci" })).not.toContain("ln -sf");
    expect(ciToolInstallLine("tofu", "1.13.1", { onPath: true }).startsWith("command -v tofu >/dev/null 2>&1 || { ")).toBe(true);
    expect(ciToolBin("aws-cli", "2.22.0", "/opt/p")).toBe("/opt/p/aws-cli-2.22.0/v2/current/bin/aws");
  });

  test("runs: installs once, then skips without a download", () => {
    const a = tarGz({ tofu: "#!/bin/sh\necho installed\n" });
    const root = tmp();
    const line = ciToolInstallLine("tofu", "1.13.1", { root, link: false, sha256: { amd64: sha(a), arm64: sha(a) } });
    const files = { "tofu_1.13.1_linux_amd64.tar.gz": a, "tofu_1.13.1_linux_arm64.tar.gz": a, "tofu_1.13.1_SHA256SUMS": `${sha(a)}  tofu_1.13.1_linux_amd64.tar.gz\n${sha(a)}  tofu_1.13.1_linux_arm64.tar.gz\n` };
    expect(runShell(line, files).status).toBe(0);
    expect(existsSync(`${root}/tofu-1.13.1/tofu`)).toBe(true);
    expect(runShell(line, files).urls).toEqual([]);
  });
});

describe("non-root job lines (#4908)", () => {
  test("sudo writes the tool root and the link, and leaves the download and the check to the job's user", () => {
    const line = ciToolInstallLine("tofu", "1.13.1", { sudo: true });
    expect(line).toContain('sudo mkdir -p "/opt/chant/tofu-1.13.1"');
    expect(line).toContain('sudo install -m 0755 "$t/tofu" "/opt/chant/tofu-1.13.1/tofu"');
    expect(line.endsWith('sudo ln -sf "/opt/chant/tofu-1.13.1/tofu" /usr/local/bin/tofu')).toBe(true);
    expect(line).not.toContain("sudo curl");
    expect(line).not.toContain("sudo sha256sum");
    expect(ciToolFetchScript("pulumi", "3.272.0", { dir: "/opt/p/pulumi-3.272.0", sudo: true })).toContain('sudo tar -xzf "$t/$f" -C "/opt/p/pulumi-3.272.0" --strip-components=1');
    expect(ciToolInstallLine("aws-cli", "2.37.9", { sudo: true })).toContain('sudo "$t/aws/install" -i "/opt/chant/aws-cli-2.37.9" -b "/opt/chant/aws-cli-2.37.9/bin"');
    expect(ciToolInstallLine("tofu", "1.13.1")).not.toContain("sudo");
  });

  test("a root and a binDir under a variable the job expands, quoted", () => {
    const line = ciToolInstallLine("aws-cli", "2.37.9", { root: "$RUNNER_TEMP/chant-tools", binDir: "${HOME}/.local/bin/" });
    expect(line.startsWith('{ [ -x "$RUNNER_TEMP/chant-tools/aws-cli-2.37.9/v2/current/bin/aws" ] || (set -e;')).toBe(true);
    expect(line.endsWith('mkdir -p "${HOME}/.local/bin" && ln -sf "$RUNNER_TEMP/chant-tools/aws-cli-2.37.9/v2/current/bin/aws" "${HOME}/.local/bin/aws"')).toBe(true);
    expect(ciToolBin("tofu", "1.13.1", "$RUNNER_TEMP/t")).toBe("$RUNNER_TEMP/t/tofu-1.13.1/tofu");
    expect(() => ciToolInstallLine("tofu", "1.13.1", { root: "$(id)/x" })).toThrow(/tool root/);
    expect(() => ciToolInstallLine("tofu", "1.13.1", { root: "relative/x" })).toThrow(/tool root/);
    expect(() => ciToolInstallLine("tofu", "1.13.1", { binDir: "$HOME x" })).toThrow(/binDir/);
    // An image's COPY expands no shell variable.
    expect(() => productImageStages({ name: "p", product: "p", description: "d", source: "s", toolRoot: "$HOME/t", tools: [{ tool: "tofu", version: "1.13.1" }], bundle: { file: "a", bin: "a" } })).toThrow(/toolRoot/);
  });

  test("runs as a user: installs under a variable root and links into a variable binDir", () => {
    const a = tarGz({ tofu: "#!/bin/sh\necho user-install\n" });
    const home = tmp();
    const line = ciToolInstallLine("tofu", "1.13.1", { root: "$TOOLS/t", binDir: "$TOOLS/bin", sha256: { amd64: sha(a), arm64: sha(a) } });
    const files = { "tofu_1.13.1_linux_amd64.tar.gz": a, "tofu_1.13.1_linux_arm64.tar.gz": a, "tofu_1.13.1_SHA256SUMS": `${sha(a)}  tofu_1.13.1_linux_amd64.tar.gz\n${sha(a)}  tofu_1.13.1_linux_arm64.tar.gz\n` };
    const r = runShell(line, files, { TOOLS: home });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readFileSync(`${home}/bin/tofu`, "utf-8")).toContain("echo user-install");
  });

  test("chant records terragucci's terraform and terragrunt pins and its drift job's AWS CLI", () => {
    expect(ciToolSha256("terraform", "1.14.9")).toEqual({ amd64: "2e5cffc20a0b48a67a76268723bd5a10b8666f69b2aa4f04906e206726bedd63", arm64: "863002085b886453795d9ff4b8989b8468784478150b70ba8a1df3e3ad66da99" });
    expect(ciToolSha256("terragrunt", "1.2.0")).toEqual({ amd64: "45b6df8a8494c8cfe34b4abf919e894709557163e4d3b5704d11083002ab787a", arm64: "b069ce4310572bc46ee6f057057acc4bc6a9077ef8687e157a64b0551290a371" });
    expect(ciToolSha256("aws-cli", "2.37.9")).toEqual({ amd64: "6b3a6a3d7bb3997928f0bdf7b866914224abf242c2e54e1dcebbe84bee64f356", arm64: "e7d2cca3622af4765871fe9ce7eeed03acd09dca10a99ebc46e92f79d78765c0" });
    // So an image carries them with no sums of the product's, and a job line can require the pin.
    expect(() => productImageStages({ name: "t", product: "t", description: "d", source: "s", tools: [{ tool: "terraform", version: "1.14.9" }, { tool: "terragrunt", version: "1.2.0" }], bundle: { file: "a", bin: "a" } })).not.toThrow();
    expect(ciToolInstallLine("terragrunt", "1.2.0", { requirePin: true, sudo: true, link: false })).toContain("want=45b6df8a");
  });
});

describe("a job with no curl or unzip (#4952)", () => {
  test("download: node fetches and checks a release with node, and the line names neither tool", () => {
    const a = tarGz({ tofu: "#!/bin/sh\necho node-fetched\n" });
    const root = tmp();
    const line = ciToolInstallLine("tofu", "1.13.1", { root, link: false, download: "node", sha256: { amd64: sha(a), arm64: sha(a) } });
    expect(line).not.toMatch(/\bcurl\b|\bunzip\b/);
    const files = { "tofu_1.13.1_linux_amd64.tar.gz": a, "tofu_1.13.1_linux_arm64.tar.gz": a, "tofu_1.13.1_SHA256SUMS": `${sha(a)}  tofu_1.13.1_linux_amd64.tar.gz\n${sha(a)}  tofu_1.13.1_linux_arm64.tar.gz\n` };
    const r = runNodeShell(line, files);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readFileSync(`${root}/tofu-1.13.1/tofu`, "utf-8")).toContain("echo node-fetched");
    expect(r.urls).toHaveLength(2);
  });

  test("download: node fails a tampered archive and a missing file, and installs nothing", () => {
    const a = tarGz({ tofu: "#!/bin/sh\n" });
    const out = tmp();
    const script = ciToolFetchScript("tofu", "1.13.1", { dir: `${out}/d`, arch: CI_TOOL_DOCKER_ARCH, download: "node", sha256: { amd64: sha(a), arm64: sha(a) } });
    const sums = `${sha(a)}  tofu_1.13.1_linux_amd64.tar.gz\n`;
    expect(runNodeShell(script, { "tofu_1.13.1_linux_amd64.tar.gz": tarGz({ tofu: "evil" }), "tofu_1.13.1_SHA256SUMS": sums }, { TARGETARCH: "amd64" }).status).not.toBe(0);
    const missing = runNodeShell(script, { "tofu_1.13.1_SHA256SUMS": sums }, { TARGETARCH: "amd64" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("tofu_1.13.1_linux_amd64.tar.gz: HTTP 404");
    expect(existsSync(`${out}/d/tofu`)).toBe(false);
  });

  test("download: node unpacks a zip's member, and the AWS CLI's whole zip for its installer", () => {
    const out = tmp();
    const z = zip({ terraform: "#!/bin/sh\necho terraform\n", "LICENSE.txt": "x" });
    const s1 = ciToolFetchScript("terraform", "1.14.8", { dir: `${out}/tf`, arch: CI_TOOL_DOCKER_ARCH, download: "node" });
    const r1 = runNodeShell(s1, { "terraform_1.14.8_linux_amd64.zip": z, "terraform_1.14.8_SHA256SUMS": `${sha(z)}  terraform_1.14.8_linux_amd64.zip\n` }, { TARGETARCH: "amd64" });
    expect(r1.stderr).toBe("");
    expect(readFileSync(`${out}/tf/terraform`, "utf-8")).toContain("echo terraform");

    // The installer writes the binary where `-i` points, as the AWS CLI's does.
    const installer = '#!/bin/sh\nmkdir -p "$2/v2/current/bin"\ncp "$(dirname "$0")/dist/aws" "$2/v2/current/bin/aws"\n';
    const aws = zip({ "aws/": "", "aws/install": installer, "aws/dist/aws": "#!/bin/sh\necho aws-cli\n" }, { "aws/install": 0o755, "aws/dist/aws": 0o755 });
    const root = tmp();
    const line = ciToolInstallLine("aws-cli", "2.37.9", { root, link: false, download: "node", sha256: { amd64: sha(aws), arm64: sha(aws) } });
    expect(line).not.toMatch(/\bcurl\b|\bunzip\b/);
    const r2 = runNodeShell(line, { "awscli-exe-linux-x86_64-2.37.9.zip": aws, "awscli-exe-linux-aarch64-2.37.9.zip": aws });
    expect(r2.stderr).toBe("");
    expect(r2.status).toBe(0);
    expect(spawnSync(`${root}/aws-cli-2.37.9/v2/current/bin/aws`, { encoding: "utf-8" }).stdout).toBe("aws-cli\n");
  });

  test("curl stays the default, and download names curl or node only", () => {
    expect(ciToolInstallLine("tofu", "1.13.1")).toContain("curl -fsSLo");
    expect(() => ciToolFetchScript("tofu", "1.13.1", { dir: "/out/t", download: "wget" as never })).toThrow(/download is curl or node/);
  });
});

describe("just's and act's checksums files and recorded sums (#4952)", () => {
  test("just 1.36.0 and act 0.2.89 are recorded, copied from the releases' checksums files", () => {
    expect(ciToolSha256("just", "1.36.0")).toEqual({ amd64: "bc7c9f377944f8de9cd0418b11d2955adebfa25a488c0b5e3dd2d2c0e9d732da", arm64: "bb3886b15e2cbcb9c0eb19956297d36de4eaef45b89d3f5fa5d1fc4ed3b5b51d" });
    expect(ciToolSha256("act", "0.2.89")).toEqual({ amd64: "0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0", arm64: "daa8679ba9615a74d2d0cec321dc593f21948a2a11bb65862b063d8b930f4bcb" });
    expect(() => ciToolInstallLine("just", "1.36.0", { requirePin: true })).not.toThrow();
    expect(() => ciToolInstallLine("act", "0.2.89", { requirePin: true })).not.toThrow();
  });

  test("each is checked against its release's checksums file: just's per file to 1.36.0, SHA256SUMS from 1.37.0, act's checksums.txt", () => {
    expect(ciToolRelease("just", "1.36.0", "amd64").checksumsUrl).toBe("https://github.com/casey/just/releases/download/1.36.0/just-1.36.0-x86_64-unknown-linux-musl.tar.gz.sha256sum");
    expect(ciToolRelease("just", "1.35.0", "arm64").checksums).toBe("just-1.35.0-aarch64-unknown-linux-musl.tar.gz.sha256sum");
    expect(ciToolRelease("just", "1.37.0", "amd64").checksumsUrl).toBe("https://github.com/casey/just/releases/download/1.37.0/SHA256SUMS");
    expect(ciToolRelease("just", "1.34.0", "amd64").checksumsUrl).toBeUndefined();
    expect(ciToolRelease("act", "0.2.89", "arm64").checksumsUrl).toBe("https://github.com/nektos/act/releases/download/v0.2.89/checksums.txt");
  });

  test("the shell reads just's per-file checksums file", () => {
    const a = tarGz({ just: "#!/bin/sh\necho just\n" });
    const out = tmp();
    const s = ciToolFetchScript("just", "1.36.0", { dir: `${out}/j`, arch: CI_TOOL_DOCKER_ARCH, sha256: { amd64: sha(a), arm64: sha(a) } });
    const r = runShell(s, { "just-1.36.0-x86_64-unknown-linux-musl.tar.gz": a, "just-1.36.0-x86_64-unknown-linux-musl.tar.gz.sha256sum": `${sha(a)}  just-1.36.0-x86_64-unknown-linux-musl.tar.gz\n` }, { TARGETARCH: "amd64" });
    expect(r.stderr).toBe("");
    expect(r.urls[1]).toBe("https://github.com/casey/just/releases/download/1.36.0/just-1.36.0-x86_64-unknown-linux-musl.tar.gz.sha256sum");
    expect(readFileSync(`${out}/j/just`, "utf-8")).toContain("echo just");
  });
});

describe("installCiTool", () => {
  const a = tarGz({ tofu: "#!/bin/sh\necho node-install\n" });
  const base = "https://github.com/opentofu/opentofu/releases/download/v1.13.1";
  const files = (archive: Uint8Array, listed = sha(archive)) => ({
    [`${base}/tofu_1.13.1_linux_amd64.tar.gz`]: archive,
    [`${base}/tofu_1.13.1_SHA256SUMS`]: `${listed}  tofu_1.13.1_linux_amd64.tar.gz\n`,
  });
  const opts = { platform: "linux", arch: "amd64" as const };

  test("installs a release that matches its checksums and its recorded sha256, then reuses it", async () => {
    const root = tmp();
    const s = served(files(a));
    const got = await installCiTool("tofu", "1.13.1", { ...opts, root, download: s.download, sha256: { amd64: sha(a) } });
    expect(got).toEqual({ dir: join(root, "tofu-1.13.1"), bin: join(root, "tofu-1.13.1", "tofu") });
    expect(readFileSync(got.bin, "utf-8")).toContain("node-install");
    const again = served({});
    await installCiTool("tofu", "1.13.1", { ...opts, root, download: again.download });
    expect(again.urls).toEqual([]);
  });

  test("refuses a tampered archive and writes nothing", async () => {
    const root = tmp();
    const evil = tarGz({ tofu: "evil" });
    await expect(installCiTool("tofu", "1.13.1", { ...opts, root, download: served(files(evil, sha(a))).download, sha256: {} })).rejects.toThrow(/has sha256 .* not installing it/);
    expect(existsSync(join(root, "tofu-1.13.1", "tofu"))).toBe(false);
  });

  test("refuses a checksums file that lists another sum than the recorded one", async () => {
    const root = tmp();
    const evil = tarGz({ tofu: "evil" });
    await expect(installCiTool("tofu", "1.13.1", { ...opts, root, download: served(files(evil)).download, sha256: { amd64: sha(a) } })).rejects.toThrow(
      `tofu 1.13.1: tofu_1.13.1_SHA256SUMS lists ${sha(evil)} for tofu_1.13.1_linux_amd64.tar.gz; chant records ${sha(a)}`,
    );
  });

  test("with no recorded sha256, the checksums file decides, unless requirePin", async () => {
    const root = tmp();
    await installCiTool("tofu", "1.13.1", { ...opts, root, download: served(files(a)).download, sha256: {} });
    expect(existsSync(join(root, "tofu-1.13.1", "tofu"))).toBe(true);
    const none = served(files(a));
    await expect(installCiTool("tofu", "1.13.1", { ...opts, root: tmp(), download: none.download, sha256: {}, requirePin: true })).rejects.toThrow(/no recorded sha256 for tofu 1.13.1 on amd64/);
    expect(none.urls).toEqual([]);
  });

  test("unpacks a zip's member, a bare binary and a tree", async () => {
    const root = tmp();
    const z = zip({ terraform: "tf" });
    const tf = "https://releases.hashicorp.com/terraform/1.14.8";
    await installCiTool("terraform", "1.14.8", { ...opts, root, download: served({ [`${tf}/terraform_1.14.8_linux_amd64.zip`]: z, [`${tf}/terraform_1.14.8_SHA256SUMS`]: `${sha(z)}  terraform_1.14.8_linux_amd64.zip\n` }).download });
    expect(readFileSync(join(root, "terraform-1.14.8", "terraform"), "utf-8")).toBe("tf");

    const cosign = Buffer.from("cosign");
    const cb = "https://github.com/sigstore/cosign/releases/download/v2.6.5";
    await installCiTool("cosign", "2.6.5", { ...opts, root, download: served({ [`${cb}/cosign-linux-amd64`]: cosign, [`${cb}/cosign_checksums.txt`]: `${sha(cosign)}  cosign-linux-amd64\n` }).download });
    expect(readFileSync(join(root, "cosign-2.6.5", "cosign"), "utf-8")).toBe("cosign");

    const tree = tarGz({ "pulumi/pulumi": "p", "pulumi/pulumi-language-nodejs": "n" });
    const pb = "https://github.com/pulumi/pulumi/releases/download/v3.300.0";
    const got = await installCiTool("pulumi", "3.300.0", { ...opts, root, download: served({ [`${pb}/pulumi-v3.300.0-linux-x64.tar.gz`]: tree, [`${pb}/pulumi-3.300.0-checksums.txt`]: `${sha(tree)}  pulumi-v3.300.0-linux-x64.tar.gz\n` }).download });
    expect(readFileSync(got.bin, "utf-8")).toBe("p");
    expect(readFileSync(join(got.dir, "pulumi-language-nodejs"), "utf-8")).toBe("n");
  });

  test("refuses another platform, and the AWS CLI's installer", async () => {
    await expect(installCiTool("tofu", "1.13.1", { platform: "darwin" })).rejects.toThrow(/Linux builds of tofu .* this machine is darwin/);
    await expect(installCiTool("aws-cli", "2.22.0", opts)).rejects.toThrow(/its own installer/);
  });

  test("checksumFor and unzipEntry read what releases publish", () => {
    expect(checksumFor(`${"A".repeat(64)} *x.tar.gz\n`, "x.tar.gz")).toBe("a".repeat(64));
    expect(checksumFor(`${"b".repeat(64)}  ./x.tar.gz\n`, "x.tar.gz")).toBe("b".repeat(64));
    expect(checksumFor(`${"b".repeat(64)}  y.tar.gz\n`, "x.tar.gz")).toBeUndefined();
    expect(Buffer.from(unzipEntry(zip({ a: "1", b: "2" }), "b")!).toString()).toBe("2");
    expect(unzipEntry(zip({ a: "1" }), "c")).toBeUndefined();
  });
});

describe("productImageStages", () => {
  const terragucci = {
    name: "terragucci-terragrunt",
    product: "terragucci",
    description: "Terragrunt 1.2.0, OpenTofu 1.13.1 and the terragucci engine",
    source: "https://github.com/INTENTIUS/terragucci",
    tools: [
      { tool: "tofu" as const, version: "1.13.1" },
      { tool: "terragrunt" as const, version: "1.2.0", sha256: { amd64: "4".repeat(64), arm64: "5".repeat(64) } },
    ],
    npm: ["@cdktn/hcl2json@0.24.0"],
    chant: "0.124.81",
    bundle: { file: "packages/terragucci/dist/terragucci.mjs", bin: "terragucci" },
  };

  test("a terragucci image: the fetch stage checks each engine against a recorded sha256, the final stage is the shared base", () => {
    const text = productImageDockerfile(terragucci);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`FROM ${CI_BASE_IMAGES.debian} AS fetch`);
    expect(lines[1]).toBe("ARG TARGETARCH");
    expect(text).toContain(`case "$a" in (amd64) want=${CI_TOOL_SHA256["tofu-1.13.1-linux-amd64"]} ;; (arm64) want=${CI_TOOL_SHA256["tofu-1.13.1-linux-arm64"]} ;;`);
    expect(text).toContain(`(amd64) want=${"4".repeat(64)} ;; (arm64) want=${"5".repeat(64)} ;;`);
    expect(lines).toContain(`FROM ${CI_BASE_IMAGES.node}`);
    const final = lines.slice(lines.indexOf(`FROM ${CI_BASE_IMAGES.node}`));
    expect(final.slice(0, 6)).toEqual(["FROM " + CI_BASE_IMAGES.node, "ARG CHANT_RELEASE_LABEL", "ENV USER=terragucci", "ENV HOME=/tmp", "ENV NODE_DISABLE_COMPILE_CACHE=1", "ENV npm_config_logs_max=0"]);
    expect(final).toContain("RUN git config --system --add safe.directory '*'");
    expect(final).toContain("RUN npm install --prefix /usr/local --no-save --omit=dev --no-audit --no-fund @cdktn/hcl2json@0.24.0 && npm cache clean --force && rm -rf /tmp/.npm");
    expect(final.some((l) => l.includes("npm pack --silent @intentius/chant@0.124.81"))).toBe(true);
    expect(final).toContain("COPY --from=fetch /opt/terragucci/ /opt/terragucci/");
    expect(final).toContain("RUN ln -sf /opt/terragucci/tofu-1.13.1/tofu /usr/local/bin/tofu && ln -sf /opt/terragucci/terragrunt-1.2.0/terragrunt /usr/local/bin/terragrunt");
    expect(final).toContain("COPY --chmod=0755 packages/terragucci/dist/terragucci.mjs /usr/local/bin/terragucci");
    expect(final.slice(-10)).toEqual([
      'LABEL org.opencontainers.image.title="terragucci-terragrunt"',
      'LABEL org.opencontainers.image.description="Terragrunt 1.2.0, OpenTofu 1.13.1 and the terragucci engine"',
      'LABEL org.opencontainers.image.version="${CHANT_RELEASE_LABEL}"',
      'LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/terragucci"',
      'LABEL org.opencontainers.image.licenses="Apache-2.0"',
      'LABEL org.opencontainers.image.base.name="node:22-bookworm-slim"',
      `LABEL org.opencontainers.image.base.digest="${CI_BASE_IMAGES.node.split("@")[1]}"`,
      'LABEL io.intentius.chant.image.base="debian"',
      'CMD ["bash"]',
      "",
    ]);
    // A Debian image stays root: no USER line, and no ENTRYPOINT.
    expect(final.some((l) => l.startsWith("USER ") || l.startsWith("ENTRYPOINT"))).toBe(false);
    // curl is in the fetch stage only.
    expect(final.join("\n")).not.toContain("curl");
  });

  test("an image refuses an engine with no recorded sha256", () => {
    expect(() => productImageStages({ ...terragucci, tools: [{ tool: "terragrunt", version: "1.1.0" }] })).toThrow(/no recorded sha256 for terragrunt 1.1.0 on amd64 and arm64/);
    expect(() => productImageStages({ ...terragucci, tools: [{ tool: "tofu", version: "1.13.1" }, { tool: "tofu", version: "1.13.1" }] })).toThrow(/listed twice/);
  });

  test("a plywood image: engine with a checksums build argument, the AWS CLI, plugin steps and a packed tarball", () => {
    const stages = productImageStages({
      name: "plywood-pulumi",
      product: "plywood",
      description: "Pulumi 3.272.0, the AWS CLI 2.22.0 and the plywood CLI",
      source: "https://github.com/INTENTIUS/plywood",
      tools: [
        { tool: "pulumi", version: "3.272.0", checksumsArg: "CHECKSUMS_URL" },
        { tool: "aws-cli", version: "2.22.0" },
      ],
      env: ["PULUMI_HOME=/opt/plywood/pulumi-home", "PULUMI_SKIP_UPDATE_CHECK=true"],
      steps: [{ run: "mkdir -p /opt/plywood/pulumi-home && chmod 1777 /opt/plywood/pulumi-home && pulumi plugin install resource command 1.0.1 && chmod -R a+rX /opt/plywood/pulumi-home" }],
      bundle: { tarball: "images/pack/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz", check: "plywood --version" },
    });
    const fetch = dockerfileText([stages[0]!]);
    expect(fetch).toContain("ARG CHECKSUMS_URL=https://github.com/pulumi/pulumi/releases/download/v3.272.0/pulumi-3.272.0-checksums.txt");
    expect(fetch).toContain('curl -fsSLo "$t/sums" "$CHECKSUMS_URL"');
    expect(fetch).toContain('tar -xzf "$t/$f" -C "/opt/plywood/pulumi-3.272.0" --strip-components=1');
    expect(fetch).toContain('"$t/aws/install" -i "/opt/plywood/aws-cli-2.22.0" -b "/opt/plywood/aws-cli-2.22.0/bin"');
    const final = dockerfileText([stages[1]!]);
    expect(final).toContain("RUN ln -sf /opt/plywood/pulumi-3.272.0/pulumi /usr/local/bin/pulumi && ln -sf /opt/plywood/aws-cli-2.22.0/v2/current/bin/aws /usr/local/bin/aws\nRUN mkdir -p /opt/plywood/pulumi-home");
    expect(final).toContain("COPY images/pack/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz");
    expect(final).toContain("RUN npm install -g --omit=dev --no-audit --no-fund /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz && rm -f /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz && npm cache clean --force && plywood --version");
  });

  test("a SQL Yodeler image: no engines, so no fetch stage; npm packages into a prefix with their own version argument", () => {
    const stages = productImageStages({
      name: "sql-yodeler",
      product: "yodel",
      description: "yodel, chant and the sql lexicon on Node 22, for CI jobs",
      source: "https://github.com/INTENTIUS/sql-yodeler",
      versionArg: "YODEL_VERSION",
      args: ["YODEL_PACKAGE", "CHANT_PINS"],
      packages: ["openssh-client"],
      bundle: {
        npm: '"${YODEL_PACKAGE:-@intentius/sql-yodeler@$YODEL_VERSION}" $CHANT_PINS',
        prefix: "/opt/yodel",
        mountContext: true,
        require: ["YODEL_VERSION"],
        check: ['test "$(yodel --version)" = "$YODEL_VERSION"', "chant --version"],
      },
    });
    expect(stages).toHaveLength(1);
    const text = dockerfileText(stages);
    expect(text).toContain("ARG YODEL_VERSION\nARG YODEL_PACKAGE\nARG CHANT_PINS\n");
    expect(text).toContain("ENV PATH=/opt/yodel/node_modules/.bin:$PATH");
    expect(text).toContain("apt-get install -y --no-install-recommends git ca-certificates openssh-client");
    expect(text).toContain('RUN --mount=type=bind,target=/ctx test -n "$YODEL_VERSION" && mkdir -p /opt/yodel && cd /opt/yodel');
    expect(text).toContain('grep -qE "E404|ETARGET" /tmp/npm.err');
    expect(text).toContain('ln -s /opt/yodel/node_modules /node_modules && test "$(yodel --version)" = "$YODEL_VERSION" && chant --version');
    expect(text).toContain('LABEL org.opencontainers.image.version="${YODEL_VERSION}"');
  });

  test("the rendered fetch stage's RUN lines pass and fail on local fixtures as the build would", () => {
    const a = tarGz({ tofu: "#!/bin/sh\n" });
    const stages = productImageStages({ ...terragucci, toolRoot: "/opt/terragucci", tools: [{ tool: "tofu", version: "1.13.1", sha256: { amd64: sha(a), arm64: sha(a) } }] });
    const run = stages[0]!.steps.map((s) => s.run).filter((r): r is string => !!r && r.startsWith("set -e;"))[0]!;
    const out = tmp();
    const local = run.replaceAll("/opt/terragucci", out);
    const good = { "tofu_1.13.1_linux_arm64.tar.gz": a, "tofu_1.13.1_SHA256SUMS": `${sha(a)}  tofu_1.13.1_linux_arm64.tar.gz\n` };
    expect(runShell(local, good, { TARGETARCH: "arm64" }).status).toBe(0);
    expect(existsSync(`${out}/tofu-1.13.1/tofu`)).toBe(true);
    const bad = { ...good, "tofu_1.13.1_linux_arm64.tar.gz": tarGz({ tofu: "evil" }) };
    expect(runShell(local.replaceAll(out, tmp()), bad, { TARGETARCH: "arm64" }).status).not.toBe(0);
  });

  test("refuses a label that would break the line, and names that are not names", () => {
    expect(() => productImageStages({ ...terragucci, description: 'say "hi"' })).toThrow(/double quote/);
    expect(() => productImageStages({ ...terragucci, npm: ["@cdktn/hcl2json@latest"] })).toThrow(/exact version/);
    expect(() => productImageStages({ ...terragucci, name: "Bad Name" })).toThrow(/image name/);
  });
});

describe("derivedImageDockerfile", () => {
  test("FROM the product's image, with the user's steps under a header", () => {
    const text = derivedImageDockerfile({
      from: "ghcr.io/intentius/plywood-pulumi:0.4.0-pulumi3.272.0@sha256:" + "6".repeat(64),
      header: ["A prepared image for plywood's jobs.", "Build and push it in your own CI."],
      steps: [{ run: "pulumi plugin install resource aws 7.4.0" }, { run: "chmod -R a+rX /opt/plywood/pulumi-home" }],
    });
    expect(text).toBe(
      [
        "# A prepared image for plywood's jobs.",
        "# Build and push it in your own CI.",
        `FROM ghcr.io/intentius/plywood-pulumi:0.4.0-pulumi3.272.0@sha256:${"6".repeat(64)}`,
        "USER root",
        "RUN pulumi plugin install resource aws 7.4.0",
        "RUN chmod -R a+rX /opt/plywood/pulumi-home",
        "USER ${CHANT_IMAGE_USER:-root}",
        "",
      ].join("\n"),
    );
    expect(() => derivedImageDockerfile({ from: "a b", steps: [] })).toThrow(/image reference/);
  });
});

describe("derivedImageDockerfile on either base (#5445)", () => {
  test("steps that set their own user get no USER line from chant", () => {
    const text = derivedImageDockerfile({ from: "img@sha256:" + "6".repeat(64), steps: [{ user: "root" }, { run: "true" }, { user: "1000" }] });
    expect(text).toBe(["FROM img@sha256:" + "6".repeat(64), "USER root", "RUN true", "USER 1000", ""].join("\n"));
  });

  test("terragucci's mirror recipe steps run as root and the image's user comes back from CHANT_IMAGE_USER", () => {
    const lines = derivedImageDockerfile({
      from: "ghcr.io/intentius/terragucci-tofu:1.0.0@sha256:" + "7".repeat(64),
      steps: [
        { arg: "TARGETOS=linux" },
        { copy: "mirror/ /tmp/terragucci-mirror/" },
        { run: "mkdir -p /usr/share/terragucci/providers; rm -rf /tmp/terragucci-mirror" },
        { env: "TF_CLI_CONFIG_FILE=/usr/share/terragucci/terragucci.tfrc" },
      ],
    }).split("\n");
    expect(lines[1]).toBe("USER root");
    expect(lines.at(-2)).toBe("USER ${CHANT_IMAGE_USER:-root}");
  });
});

describe("productImageStages with base (#5445)", () => {
  const spec = {
    name: "terragucci-tofu",
    product: "terragucci",
    description: "OpenTofu 1.13.1 and the terragucci engine",
    source: "https://github.com/INTENTIUS/terragucci",
    tools: [{ tool: "tofu" as const, version: "1.13.1" }],
    packages: ["openssh-client", "xz-utils"],
    npm: ["@cdktn/hcl2json@0.24.0"],
    chant: "0.124.81",
    bundle: { file: "packages/terragucci/dist/terragucci.mjs", bin: "terragucci" },
  };
  const stagesOf = (base?: Parameters<typeof ciImageBase>[0]) => productImageStages({ ...spec, ...(base ? { base } : {}) }).map((st) => dockerfileText([st]).split("\n"));
  const pinned = (name: string): string => WOLFI_PACKAGE_PINS[name]!.version;
  const APK_FAILED_TEXT =
    'echo "apk add failed. If Wolfi no longer serves a pinned version, move the pin: a newer chant moves its own (WOLFI_PACKAGE_PINS), and chant release images --repin <file> moves an apk:<name>=<version> entry in your source; then render this Dockerfile again." >&2; exit 1';

  test("both families from one spec: Debian with apt and root, Chainguard with apk and a final user that is not root", () => {
    const [debFetch, deb] = stagesOf("debian");
    expect(stagesOf()).toEqual([debFetch, deb]);
    expect(debFetch![0]).toBe(`FROM ${CI_BASE_IMAGES.debian} AS fetch`);
    expect(debFetch!.some((l) => l.includes("apt-get install -y --no-install-recommends ca-certificates curl unzip"))).toBe(true);
    expect(deb![0]).toBe(`FROM ${CI_BASE_IMAGES.node}`);
    expect(deb).toContain("RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client xz-utils && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache");
    expect(deb!.join("\n")).not.toContain("apk ");
    expect(deb!.filter((l) => l.startsWith("USER "))).toEqual([]);

    const [cgFetch, cg] = stagesOf("chainguard");
    expect(cgFetch![0]).toBe(`FROM ${imageRef(IMAGE_PINS.chainguardWolfiBase)} AS fetch`);
    expect(cgFetch).toContain(`RUN apk add --no-cache ca-certificates=${pinned("ca-certificates")} curl=${pinned("curl")} unzip=${pinned("unzip")} || { ${APK_FAILED_TEXT}; }`);
    expect(cgFetch!.join("\n")).not.toContain("apt-get");
    expect(cg![0]).toBe(`FROM ${imageRef(IMAGE_PINS.chainguardNode)}`);
    expect(cg![0]).toMatch(/^FROM cgr\.dev\/chainguard\/node:latest-dev@sha256:[0-9a-f]{64}$/);
    // Packages come from apk, under their Wolfi names; apt is never run.
    expect(cg).toContain(`RUN apk add --no-cache git=${pinned("git")} ca-certificates=${pinned("ca-certificates")} openssh-client=${pinned("openssh-client")} xz=${pinned("xz")} || { ${APK_FAILED_TEXT}; } && mkdir -p /usr/local/bin`);
    expect(cg!.join("\n")).not.toContain("apt-get");
    // Every install step runs as root, and the final user is not root.
    expect(cg![1]).toBe("USER root");
    const users = cg!.filter((l) => l.startsWith("USER "));
    expect(users).toEqual(["USER root", `USER ${CI_IMAGE_CHAINGUARD_USER}`]);
    expect(cg!.at(-2)).toBe("USER 65532");
    expect(cg!.at(-2)).not.toMatch(/USER (root|0)$/);
    expect(cg).toContain("ENV CHANT_IMAGE_USER=65532");
    expect(cg).toContain("ENV USER=terragucci");
    expect(cg).toContain("ENV HOME=/tmp");
    expect(cg).toContain("RUN git config --system --add safe.directory '*'");
    expect(cg).toContain("COPY --from=fetch /opt/terragucci/ /opt/terragucci/");
    expect(cg).toContain("RUN mkdir -p /opt/terragucci && chown 65532:65532 /opt/terragucci");
    expect(cg!.slice(-7, -3)).toEqual([
      'LABEL org.opencontainers.image.base.name="cgr.dev/chainguard/node:latest-dev"',
      `LABEL org.opencontainers.image.base.digest="${IMAGE_PINS.chainguardNode.digest}"`,
      'LABEL io.intentius.chant.image.base="chainguard"',
      "ENTRYPOINT []",
    ]);
    expect(cg!.at(-3)).toBe('CMD ["bash"]');
  });

  test("a Chainguard org's registry: its tags, latest-dev by default, a digest when the product records one", () => {
    const d = "a".repeat(64);
    expect(ciImageBase({ registry: "cgr.dev/example.com" })).toEqual({
      family: "chainguard",
      node: "cgr.dev/example.com/node:latest-dev",
      fetch: "cgr.dev/example.com/wolfi-base:latest",
      user: CI_IMAGE_CHAINGUARD_USER,
    });
    const base = ciImageBase({ registry: "cgr.dev/example.com/", node: `22-dev@sha256:${d}`, wolfiBase: `cgr.dev/example.com/wolfi-base:latest@sha256:${d}` });
    expect(base.node).toBe(`cgr.dev/example.com/node:22-dev@sha256:${d}`);
    expect(base.fetch).toBe(`cgr.dev/example.com/wolfi-base:latest@sha256:${d}`);
    const [fetch, final] = stagesOf({ registry: "cgr.dev/example.com", node: "22-dev" });
    expect(fetch![0]).toBe("FROM cgr.dev/example.com/wolfi-base:latest AS fetch");
    expect(final![0]).toBe("FROM cgr.dev/example.com/node:22-dev");
    // No digest recorded, so no digest label.
    expect(final!.some((l) => l.includes("image.base.digest"))).toBe(false);
    expect(final).toContain('LABEL org.opencontainers.image.base.name="cgr.dev/example.com/node:22-dev"');
    expect(() => ciImageBase({ registry: "cgr.dev/example.com", node: "other.dev/x/node:22@sha256:" + d })).toThrow(/base.node/);
    expect(() => ciImageBase({ registry: "cgr.dev/example.com", node: "22 dev" })).toThrow(/base.node/);
    expect(() => ciImageBase({ registry: "https://cgr.dev/x" })).toThrow(/base.registry/);
    expect(() => ciImageBase("alpine" as never)).toThrow(/"debian", "chainguard"/);
  });

  test("a registry route takes another image name for each image, as an <image>:<tag> or a full reference, with or without a digest", () => {
    const d = "b".repeat(64);
    // The names are fixtures: chant takes whatever image names the org holds and checks none.
    const own = ciImageBase({ registry: "cgr.dev/example.com", node: "custom-node:22-dev", wolfiBase: "custom-base:latest" });
    expect(own.node).toBe("cgr.dev/example.com/custom-node:22-dev");
    expect(own.fetch).toBe("cgr.dev/example.com/custom-base:latest");
    const pinned = ciImageBase({ registry: "cgr.dev/example.com", node: `cgr.dev/example.com/custom-node:22-dev@sha256:${d}`, wolfiBase: `custom-base:latest@sha256:${d}` });
    expect(pinned.node).toBe(`cgr.dev/example.com/custom-node:22-dev@sha256:${d}`);
    expect(pinned.fetch).toBe(`cgr.dev/example.com/custom-base:latest@sha256:${d}`);
    // The Dockerfile starts both stages from them, and the labels carry the chosen name and digest.
    const [fetch, final] = stagesOf({ registry: "cgr.dev/example.com", node: `custom-node:22-dev@sha256:${d}`, wolfiBase: "custom-base:latest" });
    expect(fetch![0]).toBe("FROM cgr.dev/example.com/custom-base:latest AS fetch");
    expect(final![0]).toBe(`FROM cgr.dev/example.com/custom-node:22-dev@sha256:${d}`);
    expect(final).toContain('LABEL org.opencontainers.image.base.name="cgr.dev/example.com/custom-node:22-dev"');
    expect(final).toContain(`LABEL org.opencontainers.image.base.digest="sha256:${d}"`);
    // The defaults stay where they were, and an image outside the registry is refused.
    expect(ciImageBase({ registry: "cgr.dev/example.com", node: "22-dev" }).node).toBe("cgr.dev/example.com/node:22-dev");
    expect(() => ciImageBase({ registry: "cgr.dev/example.com", node: "cgr.dev/other/custom-node:22-dev" })).toThrow(/base.node/);
    expect(() => ciImageBase({ registry: "cgr.dev/example.com", wolfiBase: "cgr.dev/example.com/sub/custom-base:latest" })).toThrow(/base.wolfiBase/);
    expect(() => ciImageBase({ registry: "cgr.dev/example.com", node: "Custom:22" })).toThrow(/base.node/);
    expect(() => ciImageBase({ registry: "cgr.dev/example.com", node: "custom-node:" })).toThrow(/base.node/);
  });

  test("packages: Debian names through the map, apk: and apt: entries for one family, an unmapped name refused under Chainguard", () => {
    expect(ciImagePackages("debian", ["openssh-client", "apt:python3", "apk:python-3.13"])).toEqual(["openssh-client", "python3"]);
    expect(ciImagePackages("chainguard", ["openssh-client", "dnsutils", "tar", "apt:python3", "apk:python-3.13=3.13.9-r0"])).toEqual([
      `openssh-client=${pinned("openssh-client")}`,
      `bind-tools=${pinned("bind-tools")}`,
      `gnutar=${pinned("gnutar")}`,
      "python-3.13=3.13.9-r0",
    ]);
    expect(() => ciImagePackages("chainguard", ["python3"])).toThrow(/no Wolfi name in CI_IMAGE_PACKAGE_NAMES/);
    expect(() => ciImagePackages("debian", ["Bad"])).toThrow(/not a package name/);
    expect(() => productImageStages({ ...spec, base: "chainguard", packages: ["libpq-dev"] })).toThrow(/libpq-dev/);
    expect(CI_IMAGE_PACKAGE_NAMES.git).toBe("git");
    expect(CI_IMAGE_PACKAGE_NAMES["ca-certificates"]).toBe("ca-certificates");
  });

  test("every package chant installs on Chainguard by default has a pinned version, read from Wolfi's index with its date", () => {
    const defaults = new Set(["git", "ca-certificates", "curl", "unzip", ...Object.values(CI_IMAGE_PACKAGE_NAMES)]);
    for (const name of defaults) {
      expect(WOLFI_PACKAGE_PINS[name], name).toBeDefined();
      expect(WOLFI_PACKAGE_PINS[name]!.version).toMatch(/^[0-9][0-9A-Za-z._+~]*-r[0-9]+$/);
      expect(WOLFI_PACKAGE_PINS[name]!.read).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(Object.keys(WOLFI_PACKAGE_PINS).sort()).toEqual([...defaults].sort());
  });

  test("the default Chainguard set writes every apk package at its pinned version, in both stages", () => {
    const [fetch, final] = productImageStages({ ...spec, packages: [], base: "chainguard" }).map((st) => dockerfileText([st]));
    expect(fetch).toContain(`\nRUN apk add --no-cache ca-certificates=${pinned("ca-certificates")} curl=${pinned("curl")} unzip=${pinned("unzip")} || { ${APK_FAILED_TEXT}; }\n`);
    expect(final).toContain(`\nRUN apk add --no-cache git=${pinned("git")} ca-certificates=${pinned("ca-certificates")} || { ${APK_FAILED_TEXT}; } && mkdir -p /usr/local/bin\n`);
    // No apk name goes in without a version.
    for (const line of `${fetch}${final}`.split("\n").filter((l) => l.startsWith("RUN apk add"))) {
      const words = line.slice("RUN apk add --no-cache ".length, line.indexOf(" ||")).split(" ");
      for (const w of words) expect(w).toMatch(/^[a-z0-9][a-z0-9.+-]*=[0-9][0-9A-Za-z._+~]*-r[0-9]+$/);
    }
  });

  test("a product's apk: entry: with a version it goes in at that version and replaces chant's pin; without one it is refused unless chant pins the name", () => {
    const final = (packages: string[]) => productImageStages({ ...spec, base: "chainguard", packages }).map((st) => dockerfileText([st]));
    const [fetch, withOwn] = final(["apk:python-3.13=3.13.9-r0", "apk:curl=8.23.0-r2", "apt:python3"]);
    expect(withOwn).toContain(`RUN apk add --no-cache git=${pinned("git")} ca-certificates=${pinned("ca-certificates")} python-3.13=3.13.9-r0 curl=8.23.0-r2 || {`);
    // The product's curl replaces chant's in the fetch stage too.
    expect(fetch).toContain(`RUN apk add --no-cache ca-certificates=${pinned("ca-certificates")} curl=8.23.0-r2 unzip=${pinned("unzip")} || {`);
    // A bare apk: entry for a name chant pins takes chant's version.
    expect(final(["apk:jq"])[1]).toContain(` jq=${pinned("jq")} || {`);
    // A bare apk: entry for a name chant does not pin is refused, with how to get the version.
    expect(() => final(["apk:python-3.13"])).toThrow(/apk package python-3\.13 has no version: .*"apk:python-3\.13=<version>".*apk policy python-3\.13.*chant release images --repin/);
    expect(() => ciImagePackages("chainguard", ["apk:python-3.13"])).toThrow(/has no version/);
    // A version that is not an apk version, a version on an apt: entry, and two versions of one package are refused.
    expect(() => final(["apk:python-3.13=3.13"])).toThrow(/not an apk version with its revision/);
    expect(() => final(["apt:python3=3.11.2-1"])).toThrow(/version on an apk: entry only/);
    expect(() => final(["apk:jq=1.8.2-r4", "apk:jq=1.8.2-r5"])).toThrow(/two versions, 1\.8\.2-r4 and 1\.8\.2-r5/);
    // Debian ignores apk: entries, versioned or not, and stays unpinned.
    expect(ciImagePackages("debian", ["openssh-client", "apk:python-3.13=3.13.9-r0", "apk:python-3.13"])).toEqual(["openssh-client"]);
    const deb = productImageDockerfile({ ...spec, packages: ["apk:python-3.13=3.13.9-r0"] });
    expect(deb).not.toContain("python");
    expect(deb).toContain("apt-get install -y --no-install-recommends git ca-certificates &&");
  });

  test("a Chainguard org's registry installs the same pinned versions, and an apk: entry overrides one its repositories lack", () => {
    const [fetch, final] = stagesOf({ registry: "cgr.dev/example.com", node: "22-dev" }).map((l) => l.join("\n"));
    expect(fetch).toContain(`RUN apk add --no-cache ca-certificates=${pinned("ca-certificates")} curl=${pinned("curl")} unzip=${pinned("unzip")} || {`);
    expect(final).toContain(`RUN apk add --no-cache git=${pinned("git")} ca-certificates=${pinned("ca-certificates")} openssh-client=${pinned("openssh-client")} xz=${pinned("xz")} || {`);
    const own = productImageDockerfile({ ...spec, base: { registry: "cgr.dev/example.com" }, packages: ["apk:openssl=3.6.5-r4"] });
    expect(own).toContain(` openssl=3.6.5-r4 || {`);
  });

  test("a SQL Yodeler image on Chainguard: no fetch stage, the npm prefix and its link made as root", () => {
    const stages = productImageStages({
      name: "sql-yodeler",
      product: "yodel",
      description: "yodel",
      source: "https://github.com/INTENTIUS/sql-yodeler",
      base: "chainguard",
      packages: ["openssh-client"],
      bundle: { npm: "@intentius/sql-yodeler@1.0.0", prefix: "/opt/yodel" },
    });
    expect(stages).toHaveLength(1);
    const lines = dockerfileText(stages).split("\n");
    const userRoot = lines.indexOf("USER root");
    const install = lines.findIndex((l) => l.includes("ln -s /opt/yodel/node_modules /node_modules"));
    expect(userRoot).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(userRoot);
    expect(lines.at(-2)).toBe("USER 65532");
  });
});
