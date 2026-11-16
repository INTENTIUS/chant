/**
 * The PyPI target (#5167): built wheels and sdists uploaded to PyPI, TestPyPI
 * or another index that takes PyPI's upload API.
 *
 * The files are the ones the build wrote, named one by one, by their
 * directory, or as `artifact:<name>` for the files the release records for a
 * `release.artifacts` entry. Each file that the release records must match
 * its digest. The project's name and version are read from the file's own
 * metadata: `<name>.dist-info/METADATA` in a wheel, `PKG-INFO` in an sdist.
 *
 * An index has no draft: a file is visible as soon as it is uploaded, and a
 * file name can never be uploaded again. So the stage uploads nothing. It
 * checks what it can without changing anything: the files and their
 * digests, the credential, and which files the index already serves, read
 * from its simple API (PEP 691 JSON, or PEP 503 HTML). A file the index
 * serves with the same SHA-256 is `present`; one it serves with another is
 * refused (`publish-pypi-file-exists`). The reveal uploads the rest, after
 * reading the simple API again, so a reveal run again after an upload whose
 * record was lost sends nothing twice. Nothing is out between the stage and
 * the reveal, so a check of what staged can't see this target.
 *
 * Credentials:
 *
 * - `auth: "token"`: an API token from `tokenEnv` (default `PYPI_TOKEN`, or
 *   `TEST_PYPI_TOKEN` for TestPyPI), sent as the password of user
 *   `__token__`, or of the user in `usernameEnv`.
 * - `auth: "trusted-publishing"`, PyPI and TestPyPI only: the run's OIDC ID
 *   token, from GitHub Actions or from `PYPI_ID_TOKEN` (a GitLab job's
 *   `id_tokens`), with the audience the index names at `/_/oidc/audience`,
 *   is exchanged at `/_/oidc/mint-token` for an upload token that lasts
 *   minutes. The stage makes the exchange to check that the index takes this
 *   workflow as a trusted publisher of the project, and drops the token; the
 *   reveal exchanges again for the upload.
 *
 * Unset, `auth` is a token when the token's variable is set, else trusted
 * publishing when the run has an OIDC ID token.
 *
 * A wheel carries its SBOM in `.dist-info/sboms/` (PEP 770), since an index
 * keeps no file beside a distribution. Under the `supply-chain` group a wheel
 * without one is refused (`publish-sbom-missing`) unless `sbom` is `false`.
 * The PEP 740 attestations beside each file (`<file>.<name>.attestation`, as
 * `pypi-attestations sign` writes them) are uploaded with it. When the
 * publish signs with Sigstore (`release.signing` or `supply-chain`, #5164)
 * and uploads by trusted publishing, the stage signs a publish attestation
 * (`https://docs.pypi.org/attestations/publish/v1`) for each file that has
 * none beside it, keeps it in the publish record's state, and the reveal
 * uploads it. PyPI takes attestations only from a trusted publisher, so
 * under a token nothing is signed and the stage says so.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { readCredential, type Credential } from "./publish-credentials";
import type { PypiPublishDeclaration } from "./publish-declaration";
import { bytesDigest, checkReleaseDigest, expandArtifactAssets, hasIdToken, memberFile, publishTargetKey, runIdToken } from "./publish-targets";
import type { InTotoStatement } from "./publish-signing";
import { releaseVersion } from "./publish-index";
import { pep440Version, pypiFileVersion, pypiRequirements, trainName, waitUntilServed } from "./publish-train-names";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget } from "./release-publish";

/** The first chant that publishes a `pypi` target (#5167). */
export const PUBLISH_PYPI_FLOOR = "0.124.101";

/** The variable an OIDC ID token for PyPI is read from outside GitHub Actions, as PyPI's docs name it for GitLab. */
export const PYPI_ID_TOKEN_ENV = "PYPI_ID_TOKEN";

/** Where each named index is. */
export const PYPI_INDEXES = {
  pypi: { label: "PyPI", site: "https://pypi.org", upload: "https://upload.pypi.org/legacy/", simple: "https://pypi.org/simple/", tokenEnv: "PYPI_TOKEN" },
  testpypi: { label: "TestPyPI", site: "https://test.pypi.org", upload: "https://test.pypi.org/legacy/", simple: "https://test.pypi.org/simple/", tokenEnv: "TEST_PYPI_TOKEN" },
} as const;

/** The index a declaration uploads to: a named one, or another with its own URLs and no trusted publishing. */
export function pypiIndex(decl: Pick<PypiPublishDeclaration, "index" | "uploadUrl" | "simpleUrl">): { label: string; site: string | null; upload: string; simple: string; tokenEnv: string } {
  if (decl.uploadUrl && decl.simpleUrl) {
    return { label: new URL(decl.uploadUrl).host, site: null, upload: decl.uploadUrl, simple: decl.simpleUrl.endsWith("/") ? decl.simpleUrl : `${decl.simpleUrl}/`, tokenEnv: "PYPI_TOKEN" };
  }
  return PYPI_INDEXES[decl.index ?? "pypi"];
}

/** The variable the declaration's token is read from. */
export function pypiTokenEnv(decl: Pick<PypiPublishDeclaration, "index" | "uploadUrl" | "simpleUrl" | "tokenEnv">): string {
  return decl.tokenEnv ?? pypiIndex(decl).tokenEnv;
}

/** How the target authenticates in `env`: the declared `auth`, else a token when its variable is set, else trusted publishing when the run has an OIDC ID token on PyPI or TestPyPI. */
export function pypiAuth(decl: PypiPublishDeclaration, env: NodeJS.ProcessEnv): "token" | "trusted-publishing" {
  if (decl.auth) return decl.auth;
  if (env[pypiTokenEnv(decl)]) return "token";
  return pypiIndex(decl).site !== null && hasIdToken(env, PYPI_ID_TOKEN_ENV) ? "trusted-publishing" : "token";
}

/** A project name as the simple API keys it (PEP 503). */
export function normalizeProjectName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

// Reading a distribution.

/** The names of a zip archive's entries. */
export function zipEntryNames(zip: Buffer): string[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive: no end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("a zip64 archive, which chant does not read");
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("a malformed zip central directory");
    const nameLen = zip.readUInt16LE(at + 28);
    names.push(zip.toString("utf-8", at + 46, at + 46 + nameLen));
    at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return names;
}

/** One file of a zip archive, or null. Reads stored and deflated entries. */
function zipEntry(zip: Buffer, name: string): Buffer | null {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    if (zip.toString("utf-8", at + 46, at + 46 + nameLen) === name) {
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(data, data + size);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`${name} is compressed with method ${method}, which chant does not read`);
    }
    at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return null;
}

/** Each entry of a tar archive, by name, with its bytes: ustar names with their prefix, and pax and GNU long names. */
export function tarEntries(tar: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  let longName: string | null = null;
  const str = (b: Buffer) => b.toString("utf-8").replace(/\0.*$/s, "");
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(str(header.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = str(header.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/${str(header.subarray(0, 100))}` : str(header.subarray(0, 100)));
    const body = tar.subarray(at + 512, at + 512 + size);
    longName = null;
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString("utf-8"));
      if (m) longName = m[1]!;
    } else if (type === "L") {
      longName = str(body);
    } else if (type === "0" || type === "\0") {
      out.set(name.replace(/^\.\//, ""), Buffer.from(body));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A distribution's core metadata (RFC 822 headers, then the description as the body). */
export function parseCoreMetadata(text: string): { fields: Array<[string, string]>; name: string | null; version: string | null; metadataVersion: string | null } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fields: Array<[string, string]> = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") break;
    if (/^[ \t]/.test(line) && fields.length > 0) {
      const last = fields[fields.length - 1]!;
      last[1] = `${last[1]}\n${line.replace(/^ {8}\|?|^\t/, "")}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  const body = lines.slice(i + 1).join("\n").trim();
  if (body && !fields.some(([k]) => k.toLowerCase() === "description")) fields.push(["Description", body]);
  const get = (k: string) => fields.find(([f]) => f.toLowerCase() === k)?.[1] ?? null;
  return { fields, name: get("name"), version: get("version"), metadataVersion: get("metadata-version") };
}

/** The upload API's form field for a metadata header, as twine names them. */
function formField(header: string): string {
  const h = header.toLowerCase();
  const special: Record<string, string> = { classifier: "classifiers", "project-url": "project_urls", "provides-extra": "provides_extras", "license-file": "license_files", "home-page": "home_page" };
  return special[h] ?? h.replace(/-/g, "_");
}

/** One wheel or sdist, read. */
export interface PypiDistribution {
  path: string;
  abs: string;
  file: string;
  bytes: Buffer;
  digest: string;
  filetype: "bdist_wheel" | "sdist";
  pyversion: string;
  name: string;
  version: string;
  metadata: Array<[string, string]>;
  /** The SBOM entry a wheel carries (PEP 770), if any. */
  sbom: string | null;
  /** The PEP 740 attestations beside it, and one the stage signed (`signed`). */
  attestations: Array<{ path: string; text: string; digest: string; signed?: boolean }>;
}

const DIST = /\.(whl|tar\.gz|zip)$/;

/** Read one distribution file. */
export function readDistribution(path: string, abs: string): Omit<PypiDistribution, "attestations"> {
  const file = basename(abs);
  const bytes = readFileSync(abs);
  const bad = (why: string) => new PublishTargetError("publish-pypi-not-a-distribution", `${path} is not a wheel or sdist chant can read: ${why}`, "Name the .whl and .tar.gz files the build writes, such as python -m build does.");
  let metadataText: string | null = null;
  let sbom: string | null = null;
  let filetype: PypiDistribution["filetype"];
  let pyversion: string;
  try {
    if (file.endsWith(".whl")) {
      filetype = "bdist_wheel";
      const parts = file.slice(0, -4).split("-");
      if (parts.length !== 5 && parts.length !== 6) throw new Error("its name is not <name>-<version>[-<build>]-<python>-<abi>-<platform>.whl");
      pyversion = parts[parts.length - 3]!;
      const names = zipEntryNames(bytes);
      const meta = names.find((n) => /^[^/]+\.dist-info\/METADATA$/.test(n));
      if (!meta) throw new Error("it holds no .dist-info/METADATA");
      metadataText = zipEntry(bytes, meta)?.toString("utf-8") ?? null;
      sbom = names.find((n) => /^[^/]+\.dist-info\/sboms\/[^/]+$/.test(n)) ?? null;
    } else if (file.endsWith(".tar.gz")) {
      filetype = "sdist";
      pyversion = "source";
      const entries = tarEntries(gunzipSync(bytes));
      const meta = [...entries.keys()].find((n) => /^[^/]+\/PKG-INFO$/.test(n));
      if (!meta) throw new Error("it holds no <name>-<version>/PKG-INFO");
      metadataText = entries.get(meta)!.toString("utf-8");
    } else if (file.endsWith(".zip")) {
      filetype = "sdist";
      pyversion = "source";
      const meta = zipEntryNames(bytes).find((n) => /^[^/]+\/PKG-INFO$/.test(n));
      if (!meta) throw new Error("it holds no <name>-<version>/PKG-INFO");
      metadataText = zipEntry(bytes, meta)?.toString("utf-8") ?? null;
    } else {
      throw new Error("its name ends in none of .whl, .tar.gz and .zip");
    }
  } catch (err) {
    if (err instanceof PublishTargetError) throw err;
    throw bad(err instanceof Error ? err.message : String(err));
  }
  const meta = parseCoreMetadata(metadataText ?? "");
  if (!meta.name || !meta.version || !meta.metadataVersion) throw bad("its metadata needs Metadata-Version, Name and Version");
  return { path, abs, file, bytes, digest: bytesDigest(new Uint8Array(bytes)), filetype, pyversion, name: meta.name, version: meta.version, metadata: meta.fields, sbom };
}

/** The predicate type of a PyPI publish attestation (PEP 740). */
export const PYPI_PUBLISH_PREDICATE = "https://docs.pypi.org/attestations/publish/v1";

/** The in-toto statement a PyPI publish attestation signs: the file's name and SHA-256. */
export function pypiPublishStatement(file: string, digest: string): InTotoStatement {
  return { _type: "https://in-toto.io/Statement/v1", subject: [{ name: file, digest: { sha256: digest.replace(/^sha256:/, "") } }], predicateType: PYPI_PUBLISH_PREDICATE, predicate: {} };
}

/**
 * A PEP 740 attestation from a Sigstore bundle (v0.3) over a DSSE envelope,
 * as `pypi_attestations.Attestation.from_bundle` makes it: the signing
 * certificate and transparency log entries, and the envelope's statement and
 * signature.
 */
export function pep740FromBundle(bundle: Uint8Array): Record<string, unknown> {
  const b = JSON.parse(Buffer.from(bundle).toString("utf-8")) as {
    verificationMaterial?: { certificate?: { rawBytes?: string }; x509CertificateChain?: { certificates?: Array<{ rawBytes?: string }> }; tlogEntries?: unknown[] };
    dsseEnvelope?: { payload?: string; signatures?: Array<{ sig?: string }> };
  };
  const certificate = b.verificationMaterial?.certificate?.rawBytes ?? b.verificationMaterial?.x509CertificateChain?.certificates?.[0]?.rawBytes;
  const statement = b.dsseEnvelope?.payload;
  const signature = b.dsseEnvelope?.signatures?.[0]?.sig;
  if (!certificate || !statement || !signature) throw new PublishTargetError("publish-signing-failed", "the Sigstore bundle for a PyPI attestation has no certificate, DSSE payload or signature");
  return { version: 1, verification_material: { certificate, transparency_entries: b.verificationMaterial?.tlogEntries ?? [] }, envelope: { statement, signature } };
}

/** The multipart/form-data body of an upload. */
function multipart(fields: Array<[string, string]>, file: { name: string; bytes: Buffer }): { body: Uint8Array; type: string } {
  const boundary = `chant-${randomBytes(12).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [k, v] of fields) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, "utf-8"));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`, "utf-8"), file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"));
  return { body: new Uint8Array(Buffer.concat(parts)), type: `multipart/form-data; boundary=${boundary}` };
}

export function pypiTarget(decl: PypiPublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const index = pypiIndex(decl);
  const tokenName = pypiTokenEnv(decl);

  /** Every file the declaration names, read and checked, in order. */
  const distributions = (ctx: PublishContext): PypiDistribution[] => {
    const paths: string[] = [];
    for (const entry of expandArtifactAssets(ctx.release, decl.files)) {
      const abs = memberFile(ctx.cwd, entry);
      if (statSync(abs).isDirectory()) {
        const found = readdirSync(abs).filter((f) => DIST.test(f) && statSync(join(abs, f)).isFile()).sort();
        if (found.length === 0) throw new PublishTargetError("publish-pypi-no-files", `${entry} holds no .whl, .tar.gz or .zip`, "Build the distributions before publishing, such as with python -m build.");
        paths.push(...found.map((f) => join(entry, f)));
      } else {
        paths.push(entry);
      }
    }
    const seen = new Set<string>();
    const out: PypiDistribution[] = [];
    for (const path of paths) {
      const abs = memberFile(ctx.cwd, path);
      if (seen.has(basename(abs))) throw new PublishTargetError("publish-pypi-duplicate-file", `${basename(abs)} is named twice`, "An index takes each file name once; name each file once in files.");
      seen.add(basename(abs));
      const dist = readDistribution(path, abs);
      checkReleaseDigest(ctx.release, "asset", ctx.cwd, path, [dist.digest]);
      const attestations: PypiDistribution["attestations"] = [];
      if (decl.attestations !== false) {
        for (const f of readdirSync(dirname(abs)).filter((n) => n.startsWith(`${dist.file}.`) && n.endsWith(".attestation")).sort()) {
          const attPath = join(dirname(path), f);
          const text = readFileSync(join(dirname(abs), f), "utf-8");
          try {
            const parsed = JSON.parse(text) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          } catch {
            throw new PublishTargetError("publish-pypi-attestation-invalid", `${attPath} is not a PEP 740 attestation: it is not a JSON object`, "Write it with pypi-attestations sign, or set attestations: false.");
          }
          const digest = bytesDigest(new Uint8Array(Buffer.from(text, "utf-8")));
          checkReleaseDigest(ctx.release, "asset", ctx.cwd, attPath, [digest]);
          attestations.push({ path: attPath, text, digest });
        }
      }
      out.push({ ...dist, attestations });
    }
    if (ctx.requireSbom && decl.sbom !== false) {
      const wheels = out.filter((d) => d.filetype === "bdist_wheel");
      const without = wheels.find((d) => d.sbom === null);
      if (wheels.length === 0 || without) {
        throw new PublishTargetError(
          "publish-sbom-missing",
          without
            ? `${without.file} carries no SBOM: an index keeps no file beside a distribution, so a wheel carries its SBOM in .dist-info/sboms/ (PEP 770)`
            : `${target.name} publishes no wheel, and an sdist has no place for an SBOM, so nothing it publishes carries one`,
          "Build wheels that carry an SBOM in .dist-info/sboms/, or set sbom: false to publish without one.",
        );
      }
    }
    return out;
  };

  const destination = (d: { name: string; version: string }) =>
    index.site ? `${index.site}/project/${normalizeProjectName(d.name)}/${d.version}/` : `${index.simple}${normalizeProjectName(d.name)}/`;

  const items = (dists: PypiDistribution[]): PublishItem[] =>
    dists.flatMap((d) => [
      { name: d.file, destination: destination(d), digest: d.digest, ...(d.sbom ? { sbom: d.sbom } : {}) },
      ...d.attestations.map((a) =>
        a.signed
          ? { name: basename(a.path), destination: destination(d), digest: a.digest, attachment: "attestation" as const, signs: [{ name: d.file, digest: d.digest }] }
          : { name: basename(a.path), destination: destination(d), digest: a.digest, attachment: "provenance" as const },
      ),
    ]);

  const SIGNED = "attestation:";
  /** The attestations the stage signed (#5164), from its state, added to each distribution. */
  const withSigned = (dists: PypiDistribution[], state: Record<string, string>): PypiDistribution[] =>
    dists.map((d) => {
      const text = state[`${SIGNED}${d.file}`];
      return text ? { ...d, attestations: [...d.attestations, { path: join(dirname(d.path), `${d.file}.publish.attestation`), text, digest: bytesDigest(new Uint8Array(Buffer.from(text, "utf-8"))), signed: true }] } : d;
    });

  /** The token, or null under trusted publishing; refuses a run with neither. */
  const credential = (ctx: PublishContext): { auth: "token" | "trusted-publishing"; token: Credential | null; username: string } => {
    const auth = pypiAuth(decl, ctx.env);
    if (auth === "trusted-publishing") {
      if (!hasIdToken(ctx.env, PYPI_ID_TOKEN_ENV)) {
        throw new PublishTargetError(
          "publish-credentials-missing",
          `the ${index.label} target publishes with trusted publishing, and this run has no OIDC ID token: not a GitHub Actions job with id-token: write, and ${PYPI_ID_TOKEN_ENV} is not set`,
          `In GitHub Actions, give the job permissions: id-token: write. In GitLab CI, declare ${PYPI_ID_TOKEN_ENV} under the job's id_tokens with the audience ${index.label === "TestPyPI" ? "testpypi" : "pypi"}.`,
        );
      }
      return { auth, token: null, username: "__token__" };
    }
    const token = readCredential(ctx.env, [tokenName], ctx.redactor);
    if (!token) {
      throw new PublishTargetError(
        "publish-credentials-missing",
        `the ${index.label} target reads its token from ${tokenName}, and it is not set${index.site ? ", and this run has no OIDC ID token for trusted publishing" : ""}`,
        index.site ? `Set ${tokenName} to an API token for the project, or publish from a CI job with an OIDC ID token and a trusted publisher registered on ${index.label}.` : `Set ${tokenName} to a token the index takes.`,
      );
    }
    const user = decl.usernameEnv ? readCredential(ctx.env, [decl.usernameEnv], ctx.redactor) : null;
    if (decl.usernameEnv && !user) throw new PublishTargetError("publish-credentials-missing", `the ${index.label} target reads its user from ${decl.usernameEnv}, and it is not set`, `Set ${decl.usernameEnv}.`);
    return { auth, token, username: user?.value ?? "__token__" };
  };

  const fail = (ctx: PublishContext, code: string, what: string, status: number, text: string, fix?: string): never => {
    throw new PublishTargetError(code, ctx.redactor.redact(`${what} on ${index.label} answered ${status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 300)}` : ""}`), fix);
  };

  /** The files the index serves for a project, by file name, with their SHA-256 in hex when it gives one; null when it has no such project. */
  const served = async (ctx: PublishContext, name: string): Promise<Map<string, string | null> | null> => {
    const url = `${index.simple}${normalizeProjectName(name)}/`;
    const res = await fetchImpl(url, { method: "GET", headers: { "user-agent": "chant", accept: "application/vnd.pypi.simple.v1+json, text/html;q=0.1" } });
    const text = await res.text().catch(() => "");
    if (res.status === 404) return null;
    if (res.status !== 200) fail(ctx, "publish-pypi-failed", `reading ${url}`, res.status, text);
    const out = new Map<string, string | null>();
    try {
      const json = JSON.parse(text) as { files?: Array<{ filename?: unknown; hashes?: { sha256?: unknown } }> };
      for (const f of json.files ?? []) if (typeof f.filename === "string") out.set(f.filename, typeof f.hashes?.sha256 === "string" ? f.hashes.sha256 : null);
      return out;
    } catch {
      // PEP 503 HTML: <a href="...#sha256=<hex>">file</a>
      for (const m of text.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi)) {
        const hash = /#sha256=([0-9a-f]{64})/i.exec(m[1]!);
        out.set(m[2]!.trim(), hash ? hash[1]!.toLowerCase() : null);
      }
      return out;
    }
  };

  /** Each distribution: `present` when the index serves it with the same bytes; refused when it serves the name with others. */
  const presence = async (ctx: PublishContext, dists: PypiDistribution[]): Promise<Map<string, boolean>> => {
    const byProject = new Map<string, Map<string, string | null> | null>();
    const out = new Map<string, boolean>();
    for (const d of dists) {
      if (!byProject.has(d.name)) byProject.set(d.name, await served(ctx, d.name));
      const files = byProject.get(d.name);
      if (!files || !files.has(d.file)) {
        out.set(d.file, false);
        continue;
      }
      const sha = files.get(d.file);
      if (sha && `sha256:${sha}` !== d.digest) {
        throw new PublishTargetError("publish-pypi-file-exists", `${index.label} already serves ${d.file}, with sha256:${sha}, not ${d.digest}`, "An index never takes a file name twice: cut a release with a new version.");
      }
      out.set(d.file, true);
    }
    return out;
  };

  /** Trusted publishing: an upload token for this run, exchanged for its OIDC ID token. It lasts minutes. */
  const mintToken = async (ctx: PublishContext): Promise<string> => {
    const site = index.site!;
    const aud = await fetchImpl(`${site}/_/oidc/audience`, { method: "GET", headers: { "user-agent": "chant", accept: "application/json" } });
    const audText = await aud.text().catch(() => "");
    let audience: unknown;
    try {
      audience = aud.status === 200 ? (JSON.parse(audText) as { audience?: unknown }).audience : undefined;
    } catch {
      audience = undefined;
    }
    if (typeof audience !== "string" || !audience) fail(ctx, "publish-pypi-trusted-publishing", `reading the OIDC audience at ${site}/_/oidc/audience`, aud.status, audText, `${index.label} may not take trusted publishing here; publish with a token in ${tokenName}.`);
    const jwt = await runIdToken(ctx, fetchImpl, audience as string, PYPI_ID_TOKEN_ENV, "publish-pypi-trusted-publishing");
    const res = await fetchImpl(`${site}/_/oidc/mint-token`, { method: "POST", headers: { "user-agent": "chant", "content-type": "application/json" }, body: JSON.stringify({ token: jwt }) });
    const text = await res.text().catch(() => "");
    let body: { token?: unknown; message?: unknown; errors?: Array<{ code?: unknown; description?: unknown }> } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // Reported by its status.
    }
    if (res.status < 200 || res.status > 299 || typeof body.token !== "string" || !body.token) {
      const why = (body.errors ?? []).map((e) => `${typeof e.code === "string" ? `${e.code}: ` : ""}${typeof e.description === "string" ? e.description : ""}`).filter(Boolean).join("; ");
      throw new PublishTargetError(
        "publish-pypi-trusted-publishing",
        ctx.redactor.redact(`${index.label} gave no upload token for this run's OIDC ID token: it answered ${res.status}${why ? `: ${why}` : typeof body.message === "string" ? `: ${body.message}` : ""}`),
        `Register this workflow as a trusted publisher of the project at ${site}/manage/account/publishing/ (a pending publisher for a project that does not exist yet).`,
      );
    }
    ctx.redactor.add(body.token);
    return body.token;
  };

  const upload = async (ctx: PublishContext, d: PypiDistribution, auth: { username: string; password: string }): Promise<"sent" | "present"> => {
    const fields: Array<[string, string]> = [
      [":action", "file_upload"],
      ["protocol_version", "1"],
      ["filetype", d.filetype],
      ["pyversion", d.pyversion],
      ["sha256_digest", d.digest.slice("sha256:".length)],
      ...d.metadata.map(([k, v]) => [formField(k), v] as [string, string]),
    ];
    if (d.attestations.length > 0) fields.push(["attestations", JSON.stringify(d.attestations.map((a) => JSON.parse(a.text) as unknown))]);
    const form = multipart(fields, { name: d.file, bytes: d.bytes });
    const basic = Buffer.from(`${auth.username}:${auth.password}`, "utf-8").toString("base64");
    ctx.redactor.add(basic);
    ctx.log(`uploading ${d.file} (${d.bytes.byteLength} bytes${d.attestations.length ? `, ${d.attestations.length} attestation${d.attestations.length === 1 ? "" : "s"}` : ""}) to ${index.label}`);
    const res = await fetchImpl(index.upload, { method: "POST", headers: { "user-agent": "chant", "content-type": form.type, authorization: `Basic ${basic}` }, body: form.body });
    const text = await res.text().catch(() => "");
    if (res.status === 200 || res.status === 201) return "sent";
    if ((res.status === 400 || res.status === 409) && /already exists/i.test(text)) {
      // Another upload of this name won the race or a record was lost: the index keeps the first bytes it took.
      const files = await served(ctx, d.name);
      const sha = files?.get(d.file);
      if (sha === undefined || (sha !== null && `sha256:${sha}` !== d.digest)) {
        throw new PublishTargetError("publish-pypi-file-exists", ctx.redactor.redact(`${index.label} refused ${d.file}: ${text.replace(/\s+/g, " ").slice(0, 300)}`), "An index never takes a file name twice, even after it was deleted: cut a release with a new version.");
      }
      return "present";
    }
    return fail(ctx, "publish-pypi-failed", `uploading ${d.file}`, res.status, text, res.status === 403 ? "Check that the token or the trusted publisher may upload to this project." : undefined);
  };

  const target: PublishTarget = {
    kind: "pypi",
    name: `${index.label} ${decl.files.join(", ")}`,
    destination: index.label,
    credentialEnv: [tokenName, PYPI_ID_TOKEN_ENV, ...(decl.usernameEnv ? [decl.usernameEnv] : [])],
    key: publishTargetKey(decl),
    uploadsAtReveal: true,
    /** #5165: each project the files hold, and the projects their `Requires-Dist` names outside an extra. */
    async names(ctx) {
      let dists: PypiDistribution[];
      try {
        dists = distributions(ctx);
      } catch {
        const name = pypiProjectName(ctx.cwd, decl.files);
        return { provides: name ? [trainName("pypi", name)] : [], needs: [] };
      }
      const provides = [...new Set(dists.map((d) => trainName("pypi", d.name)))];
      const needs = new Set(dists.flatMap((d) => pypiRequirements(d.metadata).map((n) => trainName("pypi", n))));
      return { provides, needs: [...needs].filter((n) => !provides.includes(n)) };
    },
    /** #5165: whether the index serves a file of the release's version of the project. */
    async published(ctx) {
      const name = pypiProjectName(ctx.cwd, decl.files);
      const version = releaseVersion(ctx.label);
      if (!name || !version) return null;
      const files = await served(ctx, name);
      if (!files) return false;
      const want = pep440Version(version);
      return [...files.keys()].some((f) => {
        const v = pypiFileVersion(f);
        return v !== null && pep440Version(v.version) === want;
      });
    },
    /** #5165: wait until the simple API lists each file the reveal uploaded. */
    async visible(ctx, published) {
      const files = published.items.filter((i) => i.attachment === undefined && !i.refused).map((i) => ({ file: i.name, project: pypiFileVersion(i.name)?.name })).filter((f): f is { file: string; project: string } => f.project !== undefined);
      if (files.length === 0) return;
      await waitUntilServed(ctx, deps, {
        what: index.label,
        code: "publish-pypi-not-served",
        check: async () => {
          const byProject = new Map<string, Map<string, string | null> | null>();
          const missing: string[] = [];
          for (const f of files) {
            if (!byProject.has(f.project)) byProject.set(f.project, await served(ctx, f.project));
            if (!byProject.get(f.project)?.has(f.file)) missing.push(f.file);
          }
          return missing;
        },
      });
    },
    async plan(ctx) {
      const dists = distributions(ctx);
      credential(ctx);
      return items(dists);
    },
    async stage(ctx) {
      let dists = distributions(ctx);
      const cred = credential(ctx);
      if (cred.token) ctx.log(`using the token from ${cred.token.from}; ${index.label} has no read-only check of a token, so whether it may upload shows at the reveal`);
      else {
        await mintToken(ctx);
        ctx.log(`${index.label} takes this run as a trusted publisher; the reveal asks for a new token, since one lasts minutes`);
      }
      const present = await presence(ctx, dists);
      const state: Record<string, string> = {};
      if (ctx.signing && decl.attestations !== false) {
        const unsigned = dists.filter((d) => !present.get(d.file) && d.attestations.length === 0);
        if (cred.auth !== "trusted-publishing") {
          if (unsigned.length > 0) ctx.log(`${index.label} takes attestations only from a trusted publisher, so ${unsigned.map((d) => d.file).join(", ")} ${unsigned.length === 1 ? "goes" : "go"} without a signed attestation under a token`);
        } else {
          for (const d of unsigned) {
            ctx.log(`signing a PyPI publish attestation for ${d.file} with ${ctx.signing.signer.name}`);
            state[`${SIGNED}${d.file}`] = JSON.stringify(pep740FromBundle(await ctx.signing.signer.signStatement(pypiPublishStatement(d.file, d.digest))));
          }
        }
      }
      dists = withSigned(dists, state);
      const all = items(dists);
      const out: PublishItem[] = all.map((i) => {
        const d = dists.find((x) => x.file === i.name || x.attestations.some((a) => basename(a.path) === i.name))!;
        return present.get(d.file) ? { ...i, present: true } : i;
      });
      const waiting = dists.filter((d) => !present.get(d.file));
      ctx.log(
        waiting.length === 0
          ? `${index.label} already serves every file with the same bytes`
          : `${waiting.map((d) => d.file).join(", ")} ${waiting.length === 1 ? "is" : "are"} uploaded at the reveal, since ${index.label} has no draft`,
      );
      const staged: StagedTarget = { target: target.name, destination: target.destination, items: out, state: waiting.length === 0 ? { present: "true" } : state };
      return staged;
    },
    async reveal(ctx, staged) {
      if (staged.state.present === "true") return { target: target.name, destination: target.destination, items: staged.items.map((i) => ({ ...i, present: true })) };
      const dists = withSigned(distributions(ctx), staged.state);
      const cred = credential(ctx);
      // Read again: a reveal run after an upload whose record was lost finds the files there.
      const present = await presence(ctx, dists);
      const sent = new Set<string>();
      let password = cred.token?.value ?? null;
      const done: string[] = [];
      for (const d of dists) {
        if (present.get(d.file)) continue;
        password ??= await mintToken(ctx);
        try {
          if ((await upload(ctx, d, { username: cred.username, password })) === "sent") sent.add(d.file);
        } catch (err) {
          if (err instanceof PublishTargetError && done.length > 0) {
            throw new PublishTargetError(err.code, `${err.message}. Uploaded before it: ${done.join(", ")}; the same publish run again uploads only the rest`, err.fix);
          }
          throw err;
        }
        done.push(d.file);
      }
      return {
        target: target.name,
        destination: target.destination,
        items: items(dists).map((i) => {
          const d = dists.find((x) => x.file === i.name || x.attestations.some((a) => basename(a.path) === i.name))!;
          return sent.has(d.file) ? i : { ...i, present: true };
        }),
      };
    },
  };
  return target;
}

/** The project name the member builds, for the doctor: from a built distribution, else `[project] name` in `pyproject.toml`. */
export function pypiProjectName(cwd: string, files: readonly string[]): string | null {
  for (const entry of files) {
    if (entry.startsWith("artifact:")) continue;
    const abs = join(cwd, entry);
    if (!existsSync(abs)) continue;
    const candidates = statSync(abs).isDirectory() ? readdirSync(abs).filter((f) => DIST.test(f)).map((f) => join(abs, f)) : [abs];
    for (const c of candidates) {
      try {
        return readDistribution(relative(cwd, c), c).name;
      } catch {
        // Try the next.
      }
    }
  }
  const pyproject = join(cwd, "pyproject.toml");
  if (!existsSync(pyproject)) return null;
  const text = readFileSync(pyproject, "utf-8");
  const section = /^\[project\][^\n]*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text);
  const name = section ? /^name\s*=\s*["']([^"']+)["']/m.exec(section[1]!) : null;
  return name ? name[1]! : null;
}
