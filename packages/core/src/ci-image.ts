/**
 * CI images and engine installs for a CI product (#4784).
 *
 * terragucci, plywood and SQL Yodeler each built their CI image the same way:
 * `node:22-bookworm-slim` by digest, git and CA certificates,
 * `safe.directory '*'`, the product's bundle and the OCI labels, with each
 * engine fetched in a separate stage and checked there. Each also installed
 * engines in a job, and terragucci at run time from Node. This module is the
 * one copy:
 *
 * - {@link ciToolRelease} names every engine release a product installs
 *   (tofu, terraform, terragrunt, choudoufu, infracost, cosign, atmos,
 *   terramate, pulumi, plunge, the AWS CLI, just, act) for Linux on amd64
 *   and arm64.
 * - {@link CI_TOOL_SHA256} records the sha256 chant knows for a release. A
 *   product records others in its own config and passes them as `sha256`.
 * - {@link ciToolFetchScript} is the shell that downloads one release and
 *   checks it, for an image's fetch stage; {@link ciToolInstallLine} is the
 *   job line that runs it unless the binary is there (with `sudo`, or under
 *   a root such as `$RUNNER_TEMP/chant-tools`, for a job that is not root,
 *   #4908). With `download: "node"` both fetch and unpack with node, for
 *   an image with no curl or unzip (#4952). {@link installCiTool} does the same from Node, for a product
 *   that installs a pinned release at run time.
 * - {@link productImageStages} is a product's image as stages a Dockerfile
 *   takes (the docker lexicon's `new Dockerfile({ stages })`), and
 *   {@link productImageDockerfile} is the same as text. The product passes
 *   its name, its bundle, its words and its engines.
 * - {@link derivedImageDockerfile} is an image a user builds FROM the
 *   product's, such as a provider mirror or preinstalled plugins.
 *
 * Every check follows one rule, in the shell and in Node. A release whose
 * project publishes a checksums file is checked against that file's line
 * for the archive, and against the recorded sha256 when there is one, so a
 * tampered checksums file fails as a tampered archive does. A release with
 * no checksums file (the AWS CLI, just before 1.35.0) needs a recorded sha256. An
 * image always needs a recorded sha256 for both architectures, and a caller
 * passes `requirePin` to ask the same of a job line or a run-time install.
 *
 * Like `./policy-engine.ts` this module imports only node built-ins and
 * chant's release floors, so a product can bundle it or import it from a
 * plain Node script.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { tarEntry } from "./policy-engine";
import { CI_IMAGE_DOCKER_STAGES_FLOOR, CI_IMAGE_FLOOR, CI_IMAGE_NON_ROOT_FLOOR, CI_TOOL_NODE_DOWNLOAD_FLOOR } from "./release-floors";

export { CI_IMAGE_DOCKER_STAGES_FLOOR, CI_IMAGE_FLOOR, CI_IMAGE_NON_ROOT_FLOOR, CI_TOOL_NODE_DOWNLOAD_FLOOR };

// ---------------------------------------------------------------------------
// Engine releases

export type CiTool =
  | "tofu"
  | "terraform"
  | "terragrunt"
  | "choudoufu"
  | "infracost"
  | "cosign"
  | "atmos"
  | "terramate"
  | "pulumi"
  | "plunge"
  | "aws-cli"
  | "just"
  | "act";

/** The architectures chant fetches, as Docker's `TARGETARCH` names them. */
export type CiToolArch = "amd64" | "arm64";
export const CI_TOOL_ARCHES: readonly CiToolArch[] = ["amd64", "arm64"];

/**
 * How a release file holds its binary: the file is the binary, a `.tar.gz`
 * or `.zip` holds it as `member`, a `.tar.gz` holds a tree with one top
 * directory that is unpacked whole (Pulumi's language hosts sit beside the
 * binary), or the AWS CLI's zip with its own installer.
 */
export type CiToolLayout = "binary" | "tar.gz" | "zip" | "tree" | "aws-cli";

interface ToolSpec {
  /** The command's name on PATH. */
  bin: string;
  /** The release's architecture word for each of chant's. */
  words: Record<CiToolArch, string>;
  base(version: string): string;
  asset(version: string, word: string): string;
  /** The checksums file, beside the asset under `base`; absent, or undefined for a version, when the release publishes none. */
  checksums?(version: string, asset: string): string | undefined;
  layout: CiToolLayout;
  /** The binary inside the archive, for `tar.gz` and `zip`. Default `bin`. */
  member?(word: string): string;
  /** The binary under the install directory, for `tree` and `aws-cli`. Default `bin`. */
  path?: string;
}

/** Whether a release version is at least `major.minor`. */
function atLeast(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = version.split(".").map((n) => Number.parseInt(n, 10));
  return a > major || (a === major && b >= minor);
}

const STD = { amd64: "amd64", arm64: "arm64" };
const GNU = { amd64: "x86_64", arm64: "aarch64" };
const NODE_WORDS = { amd64: "x64", arm64: "arm64" };

const TOOLS: Record<CiTool, ToolSpec> = {
  tofu: {
    bin: "tofu",
    words: STD,
    base: (v) => `https://github.com/opentofu/opentofu/releases/download/v${v}`,
    asset: (v, w) => `tofu_${v}_linux_${w}.tar.gz`,
    checksums: (v) => `tofu_${v}_SHA256SUMS`,
    layout: "tar.gz",
  },
  terraform: {
    bin: "terraform",
    words: STD,
    base: (v) => `https://releases.hashicorp.com/terraform/${v}`,
    asset: (v, w) => `terraform_${v}_linux_${w}.zip`,
    checksums: (v) => `terraform_${v}_SHA256SUMS`,
    layout: "zip",
  },
  terragrunt: {
    bin: "terragrunt",
    words: STD,
    base: (v) => `https://github.com/gruntwork-io/terragrunt/releases/download/v${v}`,
    asset: (_v, w) => `terragrunt_linux_${w}`,
    checksums: () => "SHA256SUMS",
    layout: "binary",
  },
  choudoufu: {
    bin: "choudoufu",
    words: STD,
    base: (v) => `https://github.com/INTENTIUS/choudoufu/releases/download/v${v}`,
    asset: (v, w) => `choudoufu_v${v}_linux_${w}.tar.gz`,
    checksums: () => "SHA256SUMS",
    layout: "tar.gz",
  },
  infracost: {
    bin: "infracost",
    words: STD,
    base: (v) => `https://github.com/infracost/infracost/releases/download/v${v}`,
    asset: (_v, w) => `infracost-linux-${w}.tar.gz`,
    // Each file has its own checksum file, in SHA256SUMS form.
    checksums: (_v, asset) => `${asset}.sha256`,
    layout: "tar.gz",
    member: (w) => `infracost-linux-${w}`,
  },
  cosign: {
    bin: "cosign",
    words: STD,
    base: (v) => `https://github.com/sigstore/cosign/releases/download/v${v}`,
    asset: (_v, w) => `cosign-linux-${w}`,
    checksums: () => "cosign_checksums.txt",
    layout: "binary",
  },
  atmos: {
    bin: "atmos",
    words: STD,
    base: (v) => `https://github.com/cloudposse/atmos/releases/download/v${v}`,
    asset: (v, w) => `atmos_${v}_linux_${w}`,
    checksums: (v) => `atmos_${v}_SHA256SUMS`,
    layout: "binary",
  },
  terramate: {
    bin: "terramate",
    words: { amd64: "x86_64", arm64: "arm64" },
    base: (v) => `https://github.com/terramate-io/terramate/releases/download/v${v}`,
    asset: (v, w) => `terramate_${v}_linux_${w}.tar.gz`,
    checksums: () => "checksums.txt",
    layout: "tar.gz",
  },
  pulumi: {
    bin: "pulumi",
    words: NODE_WORDS,
    base: (v) => `https://github.com/pulumi/pulumi/releases/download/v${v}`,
    asset: (v, w) => `pulumi-v${v}-linux-${w}.tar.gz`,
    checksums: (v) => `pulumi-${v}-checksums.txt`,
    layout: "tree",
  },
  plunge: {
    bin: "plunge",
    words: NODE_WORDS,
    base: (v) => `https://github.com/INTENTIUS/plunge/releases/download/plunge-v${v}`,
    asset: (v, w) => `plunge-v${v}-linux-${w}.tar.gz`,
    checksums: (v) => `plunge-v${v}-checksums.txt`,
    layout: "tree",
  },
  "aws-cli": {
    bin: "aws",
    words: GNU,
    base: () => "https://awscli.amazonaws.com",
    asset: (v, w) => `awscli-exe-linux-${w}-${v}.zip`,
    layout: "aws-cli",
    path: "v2/current/bin/aws",
  },
  just: {
    bin: "just",
    words: GNU,
    base: (v) => `https://github.com/casey/just/releases/download/${v}`,
    asset: (v, w) => `just-${v}-${w}-unknown-linux-musl.tar.gz`,
    // #4952: just publishes `SHA256SUMS` from 1.37.0, one `<file>.sha256sum` per file in 1.35.0 and 1.36.0, and none before.
    checksums: (v, asset) => (atLeast(v, 1, 37) ? "SHA256SUMS" : atLeast(v, 1, 35) ? `${asset}.sha256sum` : undefined),
    layout: "tar.gz",
  },
  act: {
    bin: "act",
    words: { amd64: "x86_64", arm64: "arm64" },
    base: (v) => `https://github.com/nektos/act/releases/download/v${v}`,
    asset: (_v, w) => `act_Linux_${w}.tar.gz`,
    checksums: () => "checksums.txt",
    layout: "tar.gz",
  },
};

export const CI_TOOLS: readonly CiTool[] = Object.keys(TOOLS) as CiTool[];

/**
 * The sha256 of each release file chant records, as
 * `<tool>-<version>-linux-<arch>`, copied from the release's checksums file
 * (the AWS CLI's from the archives, as plywood and terragucci recorded them).
 * A checksums file that lists another sum for one of these fails the
 * install. Add a release's two lines when a product moves to it, or record
 * them in the product's config and pass `sha256`.
 */
export const CI_TOOL_SHA256: Readonly<Record<string, string>> = {
  "tofu-1.13.1-linux-amd64": "378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69",
  "tofu-1.13.1-linux-arm64": "9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3",
  "choudoufu-0.31.0-linux-amd64": "1f38e5840b2e8c82e13a90652a9ffd75d5fbdff691f3f1a0ecee33fb8e4fae5b",
  "choudoufu-0.31.0-linux-arm64": "00c9dc5c0a4260bae577bce081bc7fb7f2cc9f56757de2da4b3bdb4afaff3586",
  "pulumi-3.272.0-linux-amd64": "58d545f2b98761051922008ebd381ecef95484d7f7a5ff7faa15d7a780ea84f6",
  "pulumi-3.272.0-linux-arm64": "4f0741901b8982c4326b702dabf483c63d2cf77c88ac42dd752b72541284a534",
  "plunge-0.1.0-linux-amd64": "22b89da39ab7dc11268c7b625fec3d99c0793c9c47bf8d031fa94e6967ee8187",
  "plunge-0.1.0-linux-arm64": "6855611b8cf8381d73f5ddf0b5c0a0d83bdc2a5bd8c50d415e52bb05a4574f83",
  "plunge-0.2.0-linux-amd64": "c9c73d05cca9ad214b7f44230a6162cdcb6ad64bbfc725bc94688b997b191495",
  "plunge-0.2.0-linux-arm64": "c176a82f038164085aa19c8ad6530d6022e560e124050e535dbe364ae0473357",
  "aws-cli-2.22.0-linux-amd64": "f315aa564190a12ae05a05bd8ab7b0645dd4a1ad71ce9e47dae4ff3dfeee8ceb",
  "aws-cli-2.22.0-linux-arm64": "c932ac00901ea3c430f3829140b8dc00fa6e9b8b99d6891929a4795947de7f3e",
  // #4908: terragucci's image pins (its TOOL_SHA256, from terraform_1.14.9_SHA256SUMS and terragrunt v1.2.0's SHA256SUMS)
  // and the AWS CLI its drift job installs (its AWS_CLI), so a product's image and job lines need no sums of their own.
  "terraform-1.14.9-linux-amd64": "2e5cffc20a0b48a67a76268723bd5a10b8666f69b2aa4f04906e206726bedd63",
  "terraform-1.14.9-linux-arm64": "863002085b886453795d9ff4b8989b8468784478150b70ba8a1df3e3ad66da99",
  "terragrunt-1.2.0-linux-amd64": "45b6df8a8494c8cfe34b4abf919e894709557163e4d3b5704d11083002ab787a",
  "terragrunt-1.2.0-linux-arm64": "b069ce4310572bc46ee6f057057acc4bc6a9077ef8687e157a64b0551290a371",
  "aws-cli-2.37.9-linux-amd64": "6b3a6a3d7bb3997928f0bdf7b866914224abf242c2e54e1dcebbe84bee64f356",
  "aws-cli-2.37.9-linux-arm64": "e7d2cca3622af4765871fe9ce7eeed03acd09dca10a99ebc46e92f79d78765c0",
  // #4952: terragucci's just and act pins (its workflows/shared.ts), read on 2026-11-10 from
  // https://github.com/casey/just/releases/download/1.36.0/just-1.36.0-{x86_64,aarch64}-unknown-linux-musl.tar.gz.sha256sum
  // and https://github.com/nektos/act/releases/download/v0.2.89/checksums.txt.
  // squawk is not here: its releases publish no checksums file, only bare binaries, and no product pins a release.
  "just-1.36.0-linux-amd64": "bc7c9f377944f8de9cd0418b11d2955adebfa25a488c0b5e3dd2d2c0e9d732da",
  "just-1.36.0-linux-arm64": "bb3886b15e2cbcb9c0eb19956297d36de4eaef45b89d3f5fa5d1fc4ed3b5b51d",
  "act-0.2.89-linux-amd64": "0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0",
  "act-0.2.89-linux-arm64": "daa8679ba9615a74d2d0cec321dc593f21948a2a11bb65862b063d8b930f4bcb",
};

/** One release file of one tool for one architecture. */
export interface CiToolRelease {
  tool: CiTool;
  version: string;
  arch: CiToolArch;
  /** The command's name on PATH. */
  bin: string;
  /** The release file's name. */
  asset: string;
  url: string;
  /** The release's checksums file, when it publishes one. */
  checksumsUrl?: string;
  /** Its name, for messages. */
  checksums?: string;
  layout: CiToolLayout;
  /** The binary inside a `tar.gz` or `zip`. */
  member: string;
  /** The binary under the install directory. */
  path: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIR = /^\/[A-Za-z0-9._/-]*$/;
/**
 * A directory a job line may name (#4908): an absolute path, or one under a
 * variable the job's shell expands, such as `$RUNNER_TEMP/chant-tools` or
 * `$HOME/.local/bin`, so a job that is not root installs where it can write.
 * Every line writes it inside double quotes.
 */
const SHELL_DIR = /^(?:\/|\$[A-Za-z_][A-Za-z0-9_]*(?=\/|$)|\$\{[A-Za-z_][A-Za-z0-9_]*\})[A-Za-z0-9._/-]*$/;

function spec(tool: CiTool): ToolSpec {
  const s = TOOLS[tool];
  if (!s) throw new Error(`chant installs ${CI_TOOLS.join(", ")}, not ${JSON.stringify(tool)}`);
  return s;
}

function checkVersion(tool: CiTool, version: string): void {
  if (!VERSION.test(version)) throw new Error(`${tool} version ${JSON.stringify(version)} is not a release version such as 1.2.3`);
}

/** The release file of `tool` at `version` for `arch`. A version is a plain semver, so it is safe on a shell line. */
export function ciToolRelease(tool: CiTool, version: string, arch: CiToolArch): CiToolRelease {
  const s = spec(tool);
  checkVersion(tool, version);
  const word = s.words[arch];
  if (!word) throw new Error(`chant fetches ${tool} for ${CI_TOOL_ARCHES.join(" and ")}, not ${JSON.stringify(arch)}`);
  const base = s.base(version);
  const asset = s.asset(version, word);
  const checksums = s.checksums?.(version, asset);
  return {
    tool,
    version,
    arch,
    bin: s.bin,
    asset,
    url: `${base}/${asset}`,
    ...(checksums ? { checksums, checksumsUrl: `${base}/${checksums}` } : {}),
    layout: s.layout,
    member: s.member?.(word) ?? s.bin,
    path: s.path ?? s.bin,
  };
}

/** The recorded sha256 of `tool` at `version` by architecture: the caller's, else {@link CI_TOOL_SHA256}'s. */
export function ciToolSha256(tool: CiTool, version: string, given?: Partial<Record<CiToolArch, string>>): Partial<Record<CiToolArch, string>> {
  spec(tool);
  checkVersion(tool, version);
  const out: Partial<Record<CiToolArch, string>> = {};
  for (const arch of CI_TOOL_ARCHES) {
    const sum = given ? given[arch] : CI_TOOL_SHA256[`${tool}-${version}-linux-${arch}`];
    if (sum === undefined) continue;
    if (!SHA256.test(sum)) throw new Error(`the recorded sha256 for ${tool} ${version} on ${arch} is not 64 lower-case hex digits`);
    out[arch] = sum;
  }
  return out;
}

/** Where a tool lives once installed: `<root>/<tool>-<version>`. A job line's root may start with a shell variable (#4908). */
export function ciToolDir(tool: CiTool, version: string, root: string): string {
  checkVersion(tool, version);
  if (!SHELL_DIR.test(root)) throw new Error(`a tool root is an absolute path of letters, digits and ._/-, or one under a variable such as $RUNNER_TEMP, not ${JSON.stringify(root)}`);
  return `${root.replace(/\/+$/, "")}/${tool}-${version}`;
}

/** The binary's path once installed under `root`. */
export function ciToolBin(tool: CiTool, version: string, root: string): string {
  const s = spec(tool);
  return `${ciToolDir(tool, version, root)}/${s.path ?? s.bin}`;
}

// ---------------------------------------------------------------------------
// The shell check, for an image's fetch stage and a job line

/** A shell expression giving the job's architecture as amd64 or arm64. */
export const CI_TOOL_JOB_ARCH = `"$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"`;

/** A Docker build's target architecture (`ARG TARGETARCH`), amd64 or arm64. */
export const CI_TOOL_DOCKER_ARCH = `"$TARGETARCH"`;

export interface CiToolCheckOptions {
  /** Recorded sums by architecture, in place of {@link CI_TOOL_SHA256}'s for this release. */
  sha256?: Partial<Record<CiToolArch, string>>;
  /** Refuse a release with no recorded sha256 for an architecture, rather than trust its checksums file alone. Default false. */
  requirePin?: boolean;
}

/**
 * How a fetch line downloads and unpacks a release (#4952): `curl` (the
 * default) with `unzip` for a zip, or `node`, which downloads with node's
 * `fetch` and unpacks a zip with node, for a job whose image carries node
 * but neither curl nor unzip. The check is the same either way; tar,
 * sha256sum and sed are still the image's.
 */
export type CiToolDownload = "curl" | "node";

/** The download line's script for `download: "node"`: `node -e <it> <url> <file>`. A failed answer exits 1 naming the URL and the status. */
const NODE_FETCH_JS =
  'const [u,o]=process.argv.slice(1);fetch(u).then(async(r)=>{if(!r.ok)throw new Error(u+": HTTP "+r.status);require("fs").writeFileSync(o,Buffer.from(await r.arrayBuffer()))}).catch((e)=>{console.error(e.message);process.exit(1)})';

/**
 * The unpack line's script for `download: "node"`: `node -e <it> <zip>
 * <dir> [member]`, every entry (or the one member) written under `dir`
 * with its executable bit and symbolic links kept, as the AWS CLI's
 * installer needs. Stored and deflated entries only, as {@link unzipEntry}
 * reads them; an entry whose path leaves `dir` fails the line. Written with
 * no single quote or `$`, so it goes inside the shell's single quotes as it is.
 */
const NODE_UNZIP_JS = [
  'const fs=require("fs"),p=require("path"),z=require("zlib");const [f,d,m]=process.argv.slice(1);const b=fs.readFileSync(f);',
  'let e=b.length-22;while(e>=0&&b.readUInt32LE(e)!==0x06054b50)e--;if(e<0)throw new Error(f+" is not a zip archive");',
  "const top=p.resolve(d);let o=b.readUInt32LE(e+16),hit=false;",
  "for(let i=b.readUInt16LE(e+10);i>0;i--){",
  'const meth=b.readUInt16LE(o+10),size=b.readUInt32LE(o+20),nl=b.readUInt16LE(o+28),xl=b.readUInt16LE(o+30),cl=b.readUInt16LE(o+32),mode=b.readUInt32LE(o+38)>>>16,l=b.readUInt32LE(o+42),n=b.toString("utf8",o+46,o+46+nl);',
  "o+=46+nl+xl+cl;if(m&&n!==m)continue;hit=true;",
  'const t=p.resolve(top,n);if(t!==top&&!t.startsWith(top+p.sep))throw new Error(n+" is outside "+d);',
  'if(n.endsWith("/")){fs.mkdirSync(t,{recursive:true});continue}',
  "const s=l+30+b.readUInt16LE(l+26)+b.readUInt16LE(l+28),raw=b.subarray(s,s+size),data=meth===0?raw:meth===8?z.inflateRawSync(raw):null;",
  'if(!data)throw new Error(n+" uses compression method "+meth);fs.mkdirSync(p.dirname(t),{recursive:true});',
  "if((mode&0o170000)===0o120000)fs.symlinkSync(data.toString(),t);else fs.writeFileSync(t,data,{mode:mode&0o111?0o755:0o644})}",
  'if(m&&!hit)throw new Error(m+" is not in "+f)',
].join("");

function checkDownload(download: unknown): CiToolDownload {
  if (download === undefined || download === "curl") return "curl";
  if (download === "node") return "node";
  throw new Error(`download is curl or node, not ${JSON.stringify(download)}`);
}

export interface CiToolFetchOptions extends CiToolCheckOptions {
  /** The directory the tool installs into, an absolute path: {@link ciToolDir} under the image's tool root. */
  dir: string;
  /** A shell expression giving amd64 or arm64. Default {@link CI_TOOL_JOB_ARCH}; an image build passes {@link CI_TOOL_DOCKER_ARCH}. */
  arch?: string;
  /** A shell word for the checksums file's URL, such as `"$CHECKSUMS_URL"`. Default the release's own. */
  checksumsUrl?: string;
  /**
   * Write into `dir` with `sudo` (#4908), for a job that runs as a user who
   * cannot write the tool root, such as GitHub's hosted runners under
   * /opt. The download and the check run as the job's user. Default false.
   */
  sudo?: boolean;
  /** Download with curl (the default) or with node, for an image with no curl or unzip (#4952). */
  download?: CiToolDownload;
}

function needPins(tool: CiTool, version: string, sums: Partial<Record<CiToolArch, string>>, requirePin: boolean): void {
  const hasSums = spec(tool).checksums?.(version, "") !== undefined;
  const missing = CI_TOOL_ARCHES.filter((a) => !sums[a]);
  if (missing.length && (requirePin || !hasSums)) {
    const why = hasSums ? "" : `; ${tool}'s release publishes no checksums file, so chant needs one`;
    throw new Error(`no recorded sha256 for ${tool} ${version} on ${missing.join(" and ")}${why}: record it from the release's checksums in the product's config and pass sha256`);
  }
}

/**
 * Shell that downloads one release into `dir` and checks it (#4784). Run it
 * under `set -e`. `arch` and `checksumsUrl` go onto the line as they are, so
 * they are the caller's shell, never a value from outside. Throws when the
 * release needs a recorded sha256 it lacks.
 */
export function ciToolFetchScript(tool: CiTool, version: string, options: CiToolFetchOptions): string {
  if (!SHELL_DIR.test(options.dir)) throw new Error(`a fetch directory is an absolute path of letters, digits and ._/-, or one under a variable such as $RUNNER_TEMP, not ${JSON.stringify(options.dir)}`);
  const su = options.sudo ? "sudo " : "";
  const s = spec(tool);
  const sums = ciToolSha256(tool, version, options.sha256);
  needPins(tool, version, sums, options.requirePin === true);
  const node = checkDownload(options.download) === "node";
  // #4952: `get <url word> <file>` and `unzipTo <zip> <dir> [member]`, with curl and unzip or with node.
  const get = (url: string, out: string): string => (node ? `node -e '${NODE_FETCH_JS}' ${url} "${out}"` : `curl -fsSLo "${out}" ${url}`);
  const unzipTo = (zipFile: string, into: string, member?: string): string =>
    node ? `node -e '${NODE_UNZIP_JS}' "${zipFile}" "${into}"${member ? ` "${member}"` : ""}` : `unzip -q${member ? " -o" : ""} "${zipFile}"${member ? ` "${member}"` : ""} -d "${into}"`;
  const name = `${tool} ${version}`;
  const base = s.base(version);
  const file = s.asset(version, "$w");
  const dir = options.dir;
  const lines = [
    `a=${options.arch ?? CI_TOOL_JOB_ARCH}`,
    `case "$a" in ${CI_TOOL_ARCHES.map((a) => `(${a}) w=${s.words[a]} ;;`).join(" ")} (*) echo "${name}: chant fetches it for ${CI_TOOL_ARCHES.join(" and ")}, not $a" >&2; exit 1 ;; esac`,
    `f="${file}"`,
    `t="$(mktemp -d)"`,
    get(`"${base}/$f"`, "$t/$f"),
    `case "$a" in ${CI_TOOL_ARCHES.filter((a) => sums[a]).map((a) => `(${a}) want=${sums[a]} ;;`).join(" ")} (*) want= ;; esac`,
  ];
  const checksums = s.checksums?.(version, file);
  if (checksums) {
    lines.push(
      get(options.checksumsUrl ?? `"${base}/${checksums}"`, "$t/sums"),
      // The archive's line, with any ./ or * before the name taken off.
      `line="$(sed -n "s#^\\([0-9a-f]\\{64\\}\\)  *[*.]*/*$f\\$#\\1#p" "$t/sums")"`,
      `{ [ -n "$line" ] || { echo "${name}: $f is not in ${checksums}" >&2; exit 1; }; }`,
      `{ [ -z "$want" ] || [ "$line" = "$want" ] || { echo "${name}: ${checksums} lists $line for $f; chant records $want" >&2; exit 1; }; }`,
      `want="$line"`,
    );
  } else {
    lines.push(`{ [ -n "$want" ] || { echo "${name}: no sha256 is recorded for $f" >&2; exit 1; }; }`);
  }
  lines.push(`echo "$want  $t/$f" | sha256sum -c - >/dev/null`, `${su}mkdir -p "${dir}"`);
  const member = s.member?.("$w") ?? s.bin;
  switch (s.layout) {
    case "binary":
      lines.push(`${su}install -m 0755 "$t/$f" "${dir}/${s.bin}"`);
      break;
    case "tar.gz":
      lines.push(`tar -xzf "$t/$f" -C "$t" "${member}"`, `${su}install -m 0755 "$t/${member}" "${dir}/${s.bin}"`);
      break;
    case "zip":
      lines.push(unzipTo("$t/$f", "$t", member), `${su}install -m 0755 "$t/${member}" "${dir}/${s.bin}"`);
      break;
    case "tree":
      lines.push(`${su}tar -xzf "$t/$f" -C "${dir}" --strip-components=1`);
      break;
    case "aws-cli":
      lines.push(unzipTo("$t/$f", "$t"), `${su}"$t/aws/install" -i "${dir}" -b "${dir}/bin"`);
      break;
  }
  return lines.join(" && ");
}

export interface CiToolInstallOptions extends CiToolCheckOptions {
  /**
   * Where the versioned directories live. Default {@link CI_TOOL_ROOT}. It
   * may start with a variable the job's shell expands (#4908), such as
   * `$RUNNER_TEMP/chant-tools`, for a job that is not root.
   */
  root?: string;
  /** Link the binary into `binDir` (default true). `false` leaves PATH alone, for a pin a step runs by its path. */
  link?: boolean;
  /**
   * Where the link goes. Default /usr/local/bin. Like `root` it may start
   * with a variable (#4908), such as `$HOME/.local/bin`; the job puts it on
   * PATH.
   */
  binDir?: string;
  /**
   * Install into `root` and link into `binDir` with `sudo` (#4908), for a
   * job that runs as a user who cannot write them, as on GitHub's hosted
   * runners. The download and the check run as the job's user. Default false.
   */
  sudo?: boolean;
  /** Skip the install when any `<bin>` is on PATH, whatever its version. Default false: only the versioned directory counts. */
  onPath?: boolean;
  /**
   * Download with curl (the default) or with node (#4952), for a job whose
   * image carries node but neither curl nor unzip, such as terragucci's
   * images installing the AWS CLI for drift attribution.
   */
  download?: CiToolDownload;
}

/** Where a job line installs each release by default. */
export const CI_TOOL_ROOT = "/opt/chant";

/**
 * The job line that installs `tool` at `version` under
 * `<root>/<tool>-<version>/`, checked as {@link ciToolFetchScript} checks
 * it. It skips the download when that directory holds the binary, as in an
 * image that carries the release, and links the binary into /usr/local/bin
 * unless `link` is false.
 */
export function ciToolInstallLine(tool: CiTool, version: string, options: CiToolInstallOptions = {}): string {
  const root = options.root ?? CI_TOOL_ROOT;
  const dir = ciToolDir(tool, version, root);
  const bin = ciToolBin(tool, version, root);
  const s = spec(tool);
  const binDir = (options.binDir ?? "/usr/local/bin").replace(/(.)\/+$/, "$1");
  if (!SHELL_DIR.test(binDir)) throw new Error(`binDir is an absolute path of letters, digits and ._/-, or one under a variable such as $HOME, not ${JSON.stringify(options.binDir)}`);
  const su = options.sudo ? "sudo " : "";
  const install = `(set -e; ${ciToolFetchScript(tool, version, { dir, sha256: options.sha256, requirePin: options.requirePin, sudo: options.sudo, download: options.download })})`;
  const inDir = `[ -x "${bin}" ]`;
  // A plain path is written as it always was; one under a variable is quoted, so the shell expands it as one word.
  const target = DIR.test(binDir) ? `${binDir}/${s.bin}` : `"${binDir}/${s.bin}"`;
  const link = `${su}${options.binDir !== undefined ? `mkdir -p "${binDir}" && ${su}` : ""}ln -sf "${bin}" ${target}`;
  const line = options.link === false ? `${inDir} || ${install}` : `{ ${inDir} || ${install}; } && ${link}`;
  return options.onPath ? `command -v ${s.bin} >/dev/null 2>&1 || { ${line}; }` : line;
}

// ---------------------------------------------------------------------------
// The run-time install, from Node

/** The expected digest for `file` in a checksums file's text, or undefined when it lists none. A name may carry `*` or `./` before it. */
export function checksumFor(sums: string, file: string): string | undefined {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(?:\.\/)?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === file) return m[1]!.toLowerCase();
  }
  return undefined;
}

/** One file out of a zip archive, by name. Stored and deflated entries only, which is what releases use. */
export function unzipEntry(zip: Uint8Array, name: string): Uint8Array | undefined {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  // The end-of-central-directory record is in the last 64 KiB plus 22 bytes.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString("utf-8", p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return new Uint8Array(data);
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      throw new Error(`zip entry ${name} uses compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

export interface InstallCiToolOptions extends CiToolCheckOptions {
  /** Fetches a release file. Default: Node's fetch. Tests pass their own. */
  download?: (url: string) => Promise<Uint8Array>;
  /** Where the versioned directories live. Default `CHANT_TOOL_CACHE`, else `chant-tools` in the temp directory. */
  root?: string;
  /** The architecture to fetch for. Default this process's. */
  arch?: CiToolArch;
  /** The platform this runs on. Default this process's; the releases are Linux builds, so any other is refused. */
  platform?: string;
}

/** This process's architecture as chant fetches it. Throws on one chant has no builds for. */
export function ciToolArch(arch: string = process.arch): CiToolArch {
  if (arch === "x64" || arch === "x86_64" || arch === "amd64") return "amd64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  throw new Error(`chant fetches tools for ${CI_TOOL_ARCHES.join(" and ")}, not ${arch}`);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Install `tool` at `version` under `<root>/<tool>-<version>/` and return
 * the directory and the binary, checked by the same rule as the shell
 * (#4784). A binary already there is returned without a download. A
 * download that does not match is never written.
 */
export async function installCiTool(tool: CiTool, version: string, options: InstallCiToolOptions = {}): Promise<{ dir: string; bin: string }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") throw new Error(`chant installs Linux builds of ${tool} for a CI job, and this machine is ${platform}; install it with your package manager`);
  const arch = options.arch ?? ciToolArch();
  const r = ciToolRelease(tool, version, arch);
  if (r.layout === "aws-cli") throw new Error("the AWS CLI installs with its own installer; use ciToolInstallLine in a job or the image's fetch stage");
  const root = options.root ?? (process.env.CHANT_TOOL_CACHE || join(tmpdir(), "chant-tools"));
  const dir = join(root, `${tool}-${version}`);
  const bin = join(dir, r.path);
  if (existsSync(bin)) return { dir, bin };

  const pinned = ciToolSha256(tool, version, options.sha256)[arch];
  if (!pinned && (options.requirePin || !r.checksumsUrl)) {
    throw new Error(`no recorded sha256 for ${tool} ${version} on ${arch} (${r.asset}): record it from the release's checksums in the product's config and pass sha256`);
  }
  const download = options.download ?? fetchBytes;
  const [body, sums] = await Promise.all([download(r.url), r.checksumsUrl ? download(r.checksumsUrl) : Promise.resolve(undefined)]);
  let want = pinned;
  if (sums !== undefined) {
    const line = checksumFor(Buffer.from(sums).toString("utf-8"), r.asset);
    if (!line) throw new Error(`${tool} ${version}: ${r.asset} is not in ${r.checksums}`);
    if (pinned && line !== pinned) throw new Error(`${tool} ${version}: ${r.checksums} lists ${line} for ${r.asset}; chant records ${pinned}`);
    want = line;
  }
  const sum = createHash("sha256").update(body).digest("hex");
  if (sum !== want) throw new Error(`${tool} ${version} from ${r.url} has sha256 ${sum}, not ${want}; not installing it`);

  const nonce = randomBytes(6).toString("hex");
  if (r.layout === "tree") {
    // Unpacked beside the directory and renamed into place, so the binary is there only when the whole tree is.
    if (existsSync(dir)) throw new Error(`${dir} is there without ${r.path}; remove it and run the install again`);
    mkdirSync(root, { recursive: true });
    const staging = join(root, `.${tool}-${version}.${nonce}`);
    mkdirSync(staging);
    const out = spawnSync("tar", ["-xz", "-C", staging, "--strip-components=1"], { input: body });
    if (out.status !== 0) throw new Error(`${r.asset} did not unpack: ${out.stderr?.toString().trim() || out.error?.message}`);
    if (!existsSync(join(staging, r.path))) throw new Error(`${r.asset} holds no ${r.path}`);
    renameSync(staging, dir);
    return { dir, bin };
  }
  mkdirSync(dir, { recursive: true });
  // Written beside its final name and renamed, so a job that stops halfway leaves no binary behind.
  const part = join(dir, `.${r.bin}.${nonce}`);
  const binary = r.layout === "binary" ? body : r.layout === "zip" ? unzipEntry(body, r.member) : tarEntry(gunzipSync(body), r.member);
  if (!binary) throw new Error(`${r.asset} holds no ${r.member}`);
  writeFileSync(part, binary);
  chmodSync(part, 0o755);
  renameSync(part, bin);
  return { dir, bin };
}

// ---------------------------------------------------------------------------
// The product image

/**
 * Base images by index digest, so a rebuild cannot change underneath a tag:
 * the ones all three products pinned. `node` carries Node 22.23.3.
 */
export const CI_BASE_IMAGES = {
  node: "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392",
  debian: "debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251",
} as const;

/** The build argument a release passes its label in (chant's release.version). */
export const CI_IMAGE_LABEL_ARG = "CHANT_RELEASE_LABEL";

/** One Dockerfile instruction, as the docker lexicon's stage `steps` take it: `{ run: "..." }`. */
/** The Dockerfile instructions a {@link CiImageStep} names. */
export type CiImageInstruction = "arg" | "env" | "run" | "copy" | "label" | "cmd" | "user" | "workdir" | "expose" | "entrypoint";

/**
 * One Dockerfile instruction, as the docker lexicon's stage `steps` take it:
 * `{ run: "..." }`. One key each, the others `never`, the shape of the
 * lexicon's `DockerfileStep`, so `new Dockerfile({ stages:
 * productImageStages(spec) })` compiles under `exactOptionalPropertyTypes`
 * (#4932).
 */
export type CiImageStep = {
  [K in CiImageInstruction]: { readonly [P in K]: string } & { readonly [P in Exclude<CiImageInstruction, K>]?: never };
}[CiImageInstruction];

/** One stage, as the docker lexicon's `new Dockerfile({ stages })` takes it. */
export interface CiImageStage {
  from: string;
  as?: string;
  steps: CiImageStep[];
}

/** One engine an image carries. */
export interface CiImageTool {
  tool: CiTool;
  version: string;
  /** Recorded sums by architecture, from the product's config, for a release chant records none for. */
  sha256?: Partial<Record<CiToolArch, string>>;
  /** A build argument naming the checksums file, defaulting to the release's own, so a tampered one can be shown to fail the build. */
  checksumsArg?: string;
  /** Link the binary into /usr/local/bin. Default true. */
  link?: boolean;
}

/** How the product's own code goes into the image. */
export type CiImageBundle =
  /** A one-file bundle in the build context, copied in as `/usr/local/bin/<bin>`. */
  | { file: string; bin: string }
  /** A tarball from `npm pack` in the build context, installed globally. `check` runs after, such as `plywood --version`. */
  | { tarball: string; check?: string }
  /**
   * Packages npm installs into `prefix`, whose `node_modules` is linked at
   * /node_modules so a checkout anywhere in the container resolves them, and
   * whose `.bin` goes on PATH. `packages` is shell words, such as
   * `"${PKG:-@scope/name@$VERSION}" $PINS`. npm lists a release before it
   * serves its tarballs, so an E404 or ETARGET is tried again, three times,
   * 45s apart. With `mountContext` the build context is at /ctx, so a packed
   * tarball installs as /ctx/<file>.tgz. `require` names build arguments
   * that must be set; `check` runs after.
   */
  | { npm: string; prefix: string; mountContext?: boolean; require?: string[]; check?: string[] };

export interface ProductImageSpec {
  /** The image's title, such as `terragucci-tofu`. */
  name: string;
  /** The product, the job's `USER` and the default tool root `/opt/<product>`. */
  product: string;
  description: string;
  /** The repository URL for `org.opencontainers.image.source`. */
  source: string;
  /** Default Apache-2.0. */
  licenses?: string;
  /** The engines, fetched and checked in a stage of their own, so curl never reaches the image. Each needs a recorded sha256 for both architectures. */
  tools?: CiImageTool[];
  /** Where the engines live. Default `/opt/<product>`. */
  toolRoot?: string;
  /** apt packages beside git and ca-certificates, such as openssh-client. */
  packages?: string[];
  /** Environment beside chant's (`USER`, `HOME=/tmp`, no Node compile cache, no npm debug logs). */
  env?: string[];
  /** npm packages installed into /usr/local, on the bundle's module path, at exact versions: `@cdktn/hcl2json@0.24.0`. */
  npm?: string[];
  /** The chant release whose one-file wave runtime is the image's `chant`, for a product whose bundle runs `chant` off PATH. */
  chant?: string;
  bundle: CiImageBundle;
  /** The product's own steps, after the engines and before the bundle, such as plugin installs. */
  steps?: CiImageStep[];
  /** The build argument the version label reads. Default {@link CI_IMAGE_LABEL_ARG}. */
  versionArg?: string;
  /** More build arguments the final stage takes. */
  args?: string[];
  /** Default `["bash"]`. */
  cmd?: string;
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const PKG = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ARG = /^[A-Za-z_][A-Za-z0-9_]*$/;

function label(field: string, value: string): string {
  if (/["\n\\]/.test(value)) throw new Error(`the image's ${field} cannot hold a double quote, a backslash or a newline`);
  return value;
}

/** apt's and dpkg's logs and ldconfig's cache carry the time of the build, so they go with the lists (#4657). */
function aptLine(packages: string[]): string {
  return `apt-get update && apt-get install -y --no-install-recommends ${packages.join(" ")} && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache`;
}

/** The fetch stage's steps for `tools`, each into its directory under `root`. */
function fetchStage(tools: CiImageTool[], root: string): CiImageStage {
  const steps: CiImageStep[] = [{ arg: "TARGETARCH" }];
  for (const t of tools) {
    if (t.checksumsArg === undefined) continue;
    if (!ARG.test(t.checksumsArg)) throw new Error(`${t.tool}: checksumsArg ${JSON.stringify(t.checksumsArg)} is not a build argument name`);
    const any = ciToolRelease(t.tool, t.version, "amd64");
    if (!any.checksumsUrl) throw new Error(`${t.tool}: its release publishes no checksums file, so checksumsArg has nothing to name`);
    steps.push({ arg: `${t.checksumsArg}=${any.checksumsUrl}` });
  }
  steps.push({ run: "apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*" });
  for (const t of tools) {
    const script = ciToolFetchScript(t.tool, t.version, {
      dir: ciToolDir(t.tool, t.version, root),
      arch: CI_TOOL_DOCKER_ARCH,
      sha256: t.sha256,
      requirePin: true,
      ...(t.checksumsArg ? { checksumsUrl: `"$${t.checksumsArg}"` } : {}),
    });
    steps.push({ run: `set -e; ${script}` });
  }
  return { from: CI_BASE_IMAGES.debian, as: "fetch", steps };
}

function bundleSteps(b: CiImageBundle): CiImageStep[] {
  if ("file" in b) {
    if (!NAME.test(b.bin)) throw new Error(`bundle.bin ${JSON.stringify(b.bin)} is not a command name`);
    return [{ copy: `--chmod=0755 ${b.file} /usr/local/bin/${b.bin}` }];
  }
  if ("tarball" in b) {
    const base = b.tarball.split("/").pop()!;
    return [
      { copy: `${b.tarball} /tmp/${base}` },
      { run: [`npm install -g --omit=dev --no-audit --no-fund /tmp/${base}`, `rm -f /tmp/${base}`, "npm cache clean --force", ...(b.check ? [b.check] : [])].join(" && ") },
    ];
  }
  if (!DIR.test(b.prefix)) throw new Error(`bundle.prefix ${JSON.stringify(b.prefix)} is not an absolute path`);
  for (const a of b.require ?? []) if (!ARG.test(a)) throw new Error(`bundle.require ${JSON.stringify(a)} is not a build argument name`);
  const install = [
    ...(b.require ?? []).map((a) => `test -n "$${a}"`),
    `mkdir -p ${b.prefix}`,
    `cd ${b.prefix}`,
    `echo '{"name":"ci-image","private":true}' > package.json`,
    `{ ok=; for try in 1 2 3; do if npm install --omit=dev --no-audit --no-fund ${b.npm} 2>/tmp/npm.err; then ok=1; break; fi; cat /tmp/npm.err >&2; grep -qE "E404|ETARGET" /tmp/npm.err || break; [ "$try" = 3 ] || sleep 45; done; test -n "$ok"; }`,
    "npm cache clean --force",
    `ln -s ${b.prefix}/node_modules /node_modules`,
    ...(b.check ?? []),
  ].join(" && ");
  return [{ run: b.mountContext ? `--mount=type=bind,target=/ctx ${install}` : install }];
}

/**
 * A product's CI image as stages (#4784): a fetch stage that downloads each
 * engine and checks it against a recorded sha256, then the pinned Node base
 * with git and CA certificates, `safe.directory '*'`, the engines, the
 * product's steps, its bundle and the OCI labels. Pass the stages to the
 * docker lexicon's `new Dockerfile({ stages })`, or write
 * {@link productImageDockerfile}'s text.
 */
export function productImageStages(spec: ProductImageSpec): CiImageStage[] {
  if (!NAME.test(spec.name)) throw new Error(`image name ${JSON.stringify(spec.name)} is not lower-case letters, digits and ._-`);
  if (!NAME.test(spec.product)) throw new Error(`product ${JSON.stringify(spec.product)} is not lower-case letters, digits and ._-`);
  const versionArg = spec.versionArg ?? CI_IMAGE_LABEL_ARG;
  for (const a of [versionArg, ...(spec.args ?? [])]) if (!ARG.test(a)) throw new Error(`build argument ${JSON.stringify(a)} is not a name`);
  for (const p of spec.packages ?? []) if (!/^[a-z0-9][a-z0-9.+-]*$/.test(p)) throw new Error(`apt package ${JSON.stringify(p)} is not a package name`);
  for (const p of spec.npm ?? []) if (!PKG.test(p)) throw new Error(`npm package ${JSON.stringify(p)} is not a name at an exact version`);
  if (spec.chant !== undefined && !VERSION.test(spec.chant)) throw new Error(`chant ${JSON.stringify(spec.chant)} is not a release version`);
  const root = spec.toolRoot ?? `/opt/${spec.product}`;
  // An image's COPY takes no shell variable, so the tool root is a plain path here.
  if (!DIR.test(root)) throw new Error(`toolRoot ${JSON.stringify(root)} is not an absolute path of letters, digits and ._/-`);
  const tools = spec.tools ?? [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.tool)) throw new Error(`${spec.name}: ${t.tool} is listed twice`);
    seen.add(t.tool);
  }

  const steps: CiImageStep[] = [];
  for (const a of [versionArg, ...(spec.args ?? [])]) steps.push({ arg: a });
  // A forge may run the job as a uid with no /etc/passwd entry, and Go then reads $USER and $HOME. A release builds each
  // image twice and the two archives must match (#4657), so Node's compile cache and npm's debug logs are not written.
  const env = [`USER=${spec.product}`, "HOME=/tmp", "NODE_DISABLE_COMPILE_CACHE=1", "npm_config_logs_max=0", ...(spec.env ?? [])];
  if ("npm" in spec.bundle) env.push(`PATH=${spec.bundle.prefix}/node_modules/.bin:$PATH`);
  for (const e of env) steps.push({ env: e });
  steps.push({ run: aptLine(["git", "ca-certificates", ...(spec.packages ?? [])]) });
  // A job often runs as another user than the one who owns its checkout, and git then refuses it ("dubious
  // ownership"). Debian's git 2.39 matches no path prefix, so it is every directory (#4768).
  steps.push({ run: "git config --system --add safe.directory '*'" });
  if (spec.npm?.length) {
    steps.push({ run: `npm install --prefix /usr/local --no-save --omit=dev --no-audit --no-fund ${spec.npm.join(" ")} && npm cache clean --force && rm -rf /tmp/.npm` });
  }
  if (spec.chant) {
    // chant's one-file wave runtime from the release (npm checks the tarball's integrity), with a `chant` on PATH that runs it.
    steps.push({
      run: [
        `cd /tmp && npm pack --silent @intentius/chant@${spec.chant}`,
        `tar -xzf intentius-chant-${spec.chant}.tgz package/dist/wave-runtime.mjs`,
        "install -D -m 0644 package/dist/wave-runtime.mjs /opt/chant/wave-runtime.mjs",
        `printf '#!/bin/sh\\nexec node /opt/chant/wave-runtime.mjs "$@"\\n' > /usr/local/bin/chant && chmod 0755 /usr/local/bin/chant`,
        "rm -rf /tmp/package /tmp/intentius-chant-*.tgz && npm cache clean --force && rm -rf /tmp/.npm",
      ].join(" && "),
    });
  }
  if (tools.length) {
    steps.push({ copy: `--from=fetch ${root}/ ${root}/` });
    const links = tools.filter((t) => t.link !== false).map((t) => `ln -sf ${ciToolBin(t.tool, t.version, root)} /usr/local/bin/${TOOLS[t.tool].bin}`);
    if (links.length) steps.push({ run: links.join(" && ") });
  }
  steps.push(...(spec.steps ?? []));
  steps.push(...bundleSteps(spec.bundle));
  steps.push(
    { label: `org.opencontainers.image.title="${spec.name}"` },
    { label: `org.opencontainers.image.description="${label("description", spec.description)}"` },
    { label: `org.opencontainers.image.version="\${${versionArg}}"` },
    { label: `org.opencontainers.image.source="${label("source", spec.source)}"` },
    { label: `org.opencontainers.image.licenses="${label("licenses", spec.licenses ?? "Apache-2.0")}"` },
    { cmd: spec.cmd ?? '["bash"]' },
  );
  return [...(tools.length ? [fetchStage(tools, root)] : []), { from: CI_BASE_IMAGES.node, steps }];
}

/** Stages as Dockerfile text, as the docker lexicon writes them, with `header` as comment lines on top. */
export function dockerfileText(stages: readonly CiImageStage[], header: readonly string[] = []): string {
  const lines = header.map((h) => (h ? `# ${h}` : "#"));
  for (const s of stages) {
    lines.push(`FROM ${s.from}${s.as ? ` AS ${s.as}` : ""}`);
    for (const step of s.steps) {
      const keys = Object.keys(step).filter((k) => step[k as keyof CiImageStep] !== undefined);
      if (keys.length !== 1) throw new Error(`a step names exactly one instruction, found ${keys.join(", ") || "none"}`);
      lines.push(`${keys[0]!.toUpperCase()} ${step[keys[0] as keyof CiImageStep]}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** A product's CI image as Dockerfile text, with `header` as comment lines on top. */
export function productImageDockerfile(spec: ProductImageSpec, header: readonly string[] = []): string {
  return dockerfileText(productImageStages(spec), header);
}

/** An image a user builds FROM the product's in their own CI. */
export interface DerivedImageSpec {
  /** The product's image, by digest when it is known. */
  from: string;
  /** Comment lines on top: what it is, how to build it, where to name it. */
  header?: readonly string[];
  steps: CiImageStep[];
}

/** A derived image's Dockerfile (#4784): FROM the product's image, the user's steps, nothing pushed. */
export function derivedImageDockerfile(spec: DerivedImageSpec): string {
  if (!spec.from || /\s/.test(spec.from)) throw new Error(`the derived image's from ${JSON.stringify(spec.from)} is not an image reference`);
  return dockerfileText([{ from: spec.from, steps: spec.steps }], spec.header ?? []);
}
