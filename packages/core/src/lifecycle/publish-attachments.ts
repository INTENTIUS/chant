/**
 * What a publish attaches to what it publishes (#4049): an SBOM and the
 * release's provenance statement.
 *
 * The provenance statement is an in-toto Statement v1 whose predicate
 * (`https://intentius.io/chant/release/v1`) names the release, its commit,
 * and the cut that signed it, with the cut's ssh signature in the
 * `chant-release` namespace. Anyone holding the repository checks that
 * signature offline with `chant release verify`, against
 * `.chant/allowed_signers` at the release's commit. The predicate also says
 * whether the run had an OIDC token: in CI, the provenance a registry records
 * (npm's `--provenance`) is signed with it, and from a workstation the
 * release's signature is the only provenance there is.
 *
 * The SBOM is an SPDX or CycloneDX JSON document. A target attaches the file
 * its declaration's `sbom` names; with none named, the OCI and forge targets
 * write one from the member's `package-lock.json` or `pom.xml` with the
 * hermetic writer `generate-sbom` uses (../components/verbs/bom-writer.ts),
 * dated with the cut's time, so a publish run again writes the same bytes.
 * `sbom: false` publishes without one. The npm target carries its SBOM in
 * each package instead, since a registry keeps no file beside a package
 * (./publish-npm.ts).
 *
 * Both are written as sorted JSON, so the same release attaches the same
 * bytes on every run, and a resumed stage finds what an earlier run sent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { sortedJsonReplacer } from "../utils";
import { writeBom } from "../components/verbs/bom-writer";
import { LOCKFILE_NAMES, LOCKFILE_PARSERS } from "../components/verbs/lockfile-sbom-generator";
import { SBOM_MEDIA_TYPES } from "../components/verbs/sbom-generator";
import { bytesDigest, checkReleaseDigest, memberFile } from "./publish-targets";
import { PublishTargetError, type PublishContext } from "./release-publish";
import { RELEASE_SEAL_NAMESPACE } from "../workspace/identity-gate-rule";

/** The in-toto statement type the provenance statement is. */
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
/** The predicate type of chant's release provenance. */
export const RELEASE_PREDICATE_TYPE = "https://intentius.io/chant/release/v1";
/** The media type an in-toto statement is attached under. */
export const IN_TOTO_MEDIA_TYPE = "application/vnd.in-toto+json";
/** The file name the provenance statement is attached under. */
export const PROVENANCE_FILE = "release.intoto.json";
/** The file name of an SBOM chant writes from a lockfile. */
export const GENERATED_SBOM_FILE = "sbom.spdx.json";
/** The names an npm package's own SBOM is looked for under, at its root, when the declaration names none. */
export const PACKAGE_SBOM_FILES = ["sbom.spdx.json", "sbom.cdx.json", "sbom.cyclonedx.json"] as const;

/** One file attached to what a target publishes. */
export interface Attachment {
  kind: "sbom" | "provenance";
  /** The file name it is attached under. */
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  digest: string;
}

const json = (value: unknown): Uint8Array => new Uint8Array(Buffer.from(`${JSON.stringify(value, sortedJsonReplacer, 2)}\n`, "utf-8"));

const attachment = (kind: Attachment["kind"], name: string, mediaType: string, bytes: Uint8Array): Attachment => ({ kind, name, mediaType, bytes, digest: bytesDigest(bytes) });

/**
 * The provenance statement for `subjects`, the digests of what the target
 * publishes. Every value in it comes from the release, its cut and the run's
 * OIDC check, never from the clock, so it is the same bytes on every run.
 */
export function releaseProvenance(ctx: PublishContext, subjects: ReadonlyArray<{ name: string; digest: string }>): Attachment {
  const cut = ctx.cut ?? null;
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: subjects.map((s) => ({ name: s.name, digest: { [s.digest.split(":")[0] ?? "sha256"]: s.digest.split(":")[1] ?? s.digest } })),
    predicateType: RELEASE_PREDICATE_TYPE,
    predicate: {
      releaseDigest: ctx.release.releaseDigest,
      label: ctx.label,
      member: ctx.release.member,
      commit: ctx.release.commit,
      cut: cut ? { actor: cut.actor, label: cut.label, timestamp: cut.timestamp, runId: cut.runId, signature: cut.signature, namespace: RELEASE_SEAL_NAMESPACE } : null,
      provenance: ctx.provenance.oidc ? { kind: "oidc", ci: ctx.provenance.ci } : { kind: "signature", ci: ctx.provenance.ci },
    },
  };
  return attachment("provenance", PROVENANCE_FILE, IN_TOTO_MEDIA_TYPE, json(statement));
}

/** The media type of an SBOM document, or null when `bytes` is neither SPDX nor CycloneDX JSON. */
export function sbomMediaType(bytes: Uint8Array): string | null {
  let doc: { spdxVersion?: unknown; bomFormat?: unknown };
  try {
    doc = JSON.parse(Buffer.from(bytes).toString("utf-8")) as typeof doc;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  if (typeof doc.spdxVersion === "string") return SBOM_MEDIA_TYPES.spdx;
  if (doc.bomFormat === "CycloneDX") return SBOM_MEDIA_TYPES.cyclonedx;
  return null;
}

function invalid(where: string): PublishTargetError {
  return new PublishTargetError("publish-sbom-invalid", `${where} is not an SPDX or CycloneDX JSON document`, "Point sbom at the SPDX or CycloneDX JSON the build writes.");
}

/**
 * The lockfile nearest the member: `package-lock.json`, `pom.xml` or
 * `Cargo.lock` in `cwd` or a directory above it inside its repository (only
 * `cwd` outside one). A member whose directory holds a `Cargo.toml` is a
 * Rust member, so its `Cargo.lock` comes first (#4168 decision 12); for any
 * other, the order is npm, Maven, Cargo.
 */
function nearestLockfile(cwd: string): { kind: "npm" | "maven" | "cargo"; path: string } | null {
  let top: string | null = null;
  try {
    top = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    top = null;
  }
  const order = existsSync(join(cwd, "Cargo.toml")) ? (["cargo", "npm", "maven"] as const) : (["npm", "maven", "cargo"] as const);
  let dir = realpathSync(cwd);
  for (;;) {
    for (const kind of order) {
      if (existsSync(join(dir, LOCKFILE_NAMES[kind]))) return { kind, path: join(dir, LOCKFILE_NAMES[kind]) };
    }
    const up = dirname(dir);
    if (top === null || dir === top || up === dir || !up.startsWith(top)) return null;
    dir = up;
  }
}

/**
 * The SBOM a target attaches, for an OCI image or a forge release: the file
 * `declared` names (relative to the member, checked against the release's
 * digest when the release records it), else one written from the member's
 * lockfile for `subject`. Null when `declared` is `false`, and when there is
 * neither and `ctx.requireSbom` is not set (#4168). Throws
 * `publish-sbom-missing` when there is neither under `supply-chain`.
 */
export function memberSbom(ctx: PublishContext, declared: string | false | undefined, subject: string, target: string): Attachment | null {
  if (declared === false) return null;
  if (declared !== undefined) {
    const abs = memberFile(ctx.cwd, declared);
    const bytes = new Uint8Array(readFileSync(abs));
    checkReleaseDigest(ctx.release, "asset", ctx.cwd, declared, [bytesDigest(bytes)]);
    const mediaType = sbomMediaType(bytes);
    if (!mediaType) throw invalid(declared);
    return attachment("sbom", declared.split("/").pop() ?? declared, mediaType, bytes);
  }
  const lock = nearestLockfile(ctx.cwd);
  if (!lock) {
    if (!ctx.requireSbom) return null;
    throw new PublishTargetError(
      "publish-sbom-missing",
      `${target} attaches an SBOM to what it publishes, and its declaration names none and there is no package-lock.json, pom.xml or Cargo.lock in ${ctx.cwd} or above it to write one from`,
      "Set sbom in the declaration to the SPDX or CycloneDX file the build writes, or sbom: false to publish without one.",
    );
  }
  const content = readFileSync(lock.path, "utf-8");
  const packages = LOCKFILE_PARSERS[lock.kind](content);
  const at = new Date(ctx.cut?.timestamp ?? 0);
  const doc = writeBom(
    "spdx",
    { subjectName: subject, subjectId: ctx.release.releaseDigest, packages, generator: `chant-lockfile-sbom/${LOCKFILE_NAMES[lock.kind]}` },
    () => (Number.isNaN(at.getTime()) ? new Date(0) : at),
  );
  return attachment("sbom", GENERATED_SBOM_FILE, doc.mediaType, new Uint8Array(Buffer.from(doc.bytes, "utf-8")));
}

/**
 * The SBOM an npm package carries at its root: the file `declared` names, else
 * the first of {@link PACKAGE_SBOM_FILES} it holds, in a package directory or
 * under `package/` in a packed `.tgz`. Null when `declared` is `false`, and
 * when the package has none and `required` is false (#4168). Throws
 * `publish-sbom-missing` when it has none and `required` is set (the
 * `supply-chain` group) or `declared` names a file, and
 * `publish-sbom-invalid` when it is not SPDX or CycloneDX JSON.
 */
export function packageSbom(abs: string, isDirectory: boolean, path: string, name: string, declared: string | false | undefined, required = false): { file: string; digest: string } | null {
  if (declared === false) return null;
  const candidates = declared !== undefined ? [declared] : [...PACKAGE_SBOM_FILES];
  let listed: Set<string> | null = null;
  if (!isDirectory) {
    try {
      listed = new Set(execFileSync("tar", ["-tzf", abs], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((l) => l.trim()));
    } catch {
      listed = new Set();
    }
  }
  for (const file of candidates) {
    let bytes: Uint8Array | null = null;
    if (isDirectory) {
      if (existsSync(join(abs, file))) bytes = new Uint8Array(readFileSync(join(abs, file)));
    } else if (listed!.has(`package/${file}`)) {
      bytes = new Uint8Array(execFileSync("tar", ["-xzOf", abs, `package/${file}`], { stdio: ["ignore", "pipe", "ignore"] }));
    }
    if (bytes === null) continue;
    if (!sbomMediaType(bytes)) throw invalid(`${file} in ${path}`);
    return { file, digest: bytesDigest(bytes) };
  }
  if (!required && declared === undefined) return null;
  throw new PublishTargetError(
    "publish-sbom-missing",
    `${name} (${path}) carries no SBOM: npm keeps no file beside a package, so its SBOM goes in it, and ${declared !== undefined ? declared : `none of ${PACKAGE_SBOM_FILES.join(", ")}`} is at its root`,
    `Write one into the package before it is packed, such as npm sbom --sbom-format spdx > ${path}/sbom.spdx.json, and keep it in the package's files; or set sbom: false to publish without one.`,
  );
}
