import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  CI_BASE_IMAGES,
  CI_IMAGE_DOCKER_STAGES_FLOOR,
  CI_IMAGE_FLOOR,
  CI_IMAGE_NON_ROOT_FLOOR,
  CI_TOOL_DOCKER_ARCH,
  CI_TOOL_SHA256,
  CI_TOOLS,
  checksumFor,
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
import { NEXT_RELEASE } from "./release-floors";

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

/** A zip of `files`, deflated, with a central directory, as a release's `.zip` holds them. */
function zip(files: Record<string, string>): Uint8Array {
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

  test("CI_IMAGE_FLOOR is the release that shipped it, and #4908's and #4932's floors the next", () => {
    expect(CI_IMAGE_FLOOR).toBe("0.124.86");
    expect(CI_IMAGE_NON_ROOT_FLOOR).toBe(NEXT_RELEASE);
    expect(CI_IMAGE_DOCKER_STAGES_FLOOR).toBe(NEXT_RELEASE);
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
    const script = ciToolFetchScript("just", "1.36.0", { dir: `${out}/d`, arch: CI_TOOL_DOCKER_ARCH, sha256: { amd64: sha(archiveJust), arm64: "2".repeat(64) } });
    expect(script).not.toContain("sums");
    expect(runShell(script, { "just-1.36.0-x86_64-unknown-linux-musl.tar.gz": archiveJust }, { TARGETARCH: "amd64" }).status).toBe(0);
    expect(readFileSync(`${out}/d/just`, "utf-8")).toContain("echo just");
    const r = runShell(script, { "just-1.36.0-aarch64-unknown-linux-musl.tar.gz": archiveJust }, { TARGETARCH: "arm64" });
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
    expect(() => ciToolFetchScript("act", "0.2.89", { dir: "/out/act" })).toThrow(/no recorded sha256 for act 0.2.89 on amd64 and arm64; act's release publishes no checksums file/);
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
    expect(final.slice(-7)).toEqual([
      'LABEL org.opencontainers.image.title="terragucci-terragrunt"',
      'LABEL org.opencontainers.image.description="Terragrunt 1.2.0, OpenTofu 1.13.1 and the terragucci engine"',
      'LABEL org.opencontainers.image.version="${CHANT_RELEASE_LABEL}"',
      'LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/terragucci"',
      'LABEL org.opencontainers.image.licenses="Apache-2.0"',
      'CMD ["bash"]',
      "",
    ]);
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
        "RUN pulumi plugin install resource aws 7.4.0",
        "RUN chmod -R a+rX /opt/plywood/pulumi-home",
        "",
      ].join("\n"),
    );
    expect(() => derivedImageDockerfile({ from: "a b", steps: [] })).toThrow(/image reference/);
  });
});
