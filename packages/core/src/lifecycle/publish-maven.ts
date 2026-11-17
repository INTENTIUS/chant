/**
 * The Maven Central target (#5232): a bundle of Maven components uploaded to
 * the Central Portal (`POST /api/v1/publisher/upload`).
 *
 * The bundle is a `.zip` in Maven repository layout
 * (`<group path>/<artifactId>/<version>/<artifactId>-<version>.pom` and the
 * files beside it), a directory in that layout, which chant zips, or
 * `artifact:<name>` for the one `.zip` the release records for that entry. A
 * directory gets a `.md5` and `.sha1` for each file that has none, as Central
 * asks; chant signs nothing, so each file needs its `.asc` beside it, from the
 * build (`publish-maven-unsigned`). A file the release records must match its
 * digest.
 *
 * The Portal holds a deployment it has validated until someone publishes it,
 * so this target stages for real. The stage reads the repository
 * (`https://repo1.maven.org/maven2/`) for each component's `.pom`: a
 * component it serves with the same bytes is `present`, one with other
 * bytes, or a bundle only part of which is there, is refused
 * (`publish-maven-version-exists`). It then uploads the bundle with
 * `publishingType=USER_MANAGED` and waits until the Portal says `VALIDATED`;
 * `FAILED` is refused with the Portal's errors (`publish-maven-invalid`), and
 * the deployment is left in the Portal for a person to read. The deployment's
 * id goes in the publish record's state. The reveal publishes that deployment
 * (`POST /api/v1/publisher/deployment/<id>`); one the Portal already
 * publishes is not sent again.
 *
 * Credentials: a Central Portal user token, its name from `usernameEnv`
 * (default `MAVEN_CENTRAL_USERNAME`) and its password from `passwordEnv`
 * (default `MAVEN_CENTRAL_PASSWORD`), sent as `Authorization: Bearer
 * <base64 of name:password>`. The Portal has no trusted publishing.
 *
 * Maven Central keeps every version it publishes and has no deprecation, so
 * the target has no status change, and `chant release yank` refuses it.
 *
 * Under the `supply-chain` group a component with no SBOM in it (a file
 * ending `-cyclonedx.json`, `-cyclonedx.xml` or `-spdx.json`, as the
 * CycloneDX and SPDX Maven plugins attach one) is refused unless `sbom` is
 * `false`.
 */

import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readCredential } from "./publish-credentials";
import type { MavenPublishDeclaration } from "./publish-declaration";
import { releaseVersion } from "./publish-index";
import { zipEntry, zipEntryNames } from "./publish-pypi";
import { bytesDigest, checkReleaseDigest, expandArtifactAssets, memberFile, publishTargetKey } from "./publish-targets";
import { trainName, waitUntilServed } from "./publish-train-names";
import { zipArchive } from "./release-artifacts";
import { PublishTargetError, type PublishContext, type PublishContextBase, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget } from "./release-publish";

/** The first chant that publishes a `maven` target (#5232). */
export const PUBLISH_MAVEN_FLOOR = "0.124.102";

export const CENTRAL_PORTAL = "https://central.sonatype.com";
export const MAVEN_CENTRAL_REPOSITORY = "https://repo1.maven.org/maven2/";
/** How often the stage asks the Portal whether it has validated the bundle. */
export const MAVEN_STATUS_POLL_MS = 10_000;
/** How long the stage waits for the Portal to validate the bundle. */
export const MAVEN_VALIDATION_WAIT_MS = 30 * 60_000;
/** How long a train waits for the repository to serve what the reveal published: Central takes up to half an hour. */
export const MAVEN_VISIBLE_WAIT_MS = 60 * 60_000;

export const mavenUsernameEnv = (decl: Pick<MavenPublishDeclaration, "usernameEnv">): string => decl.usernameEnv ?? "MAVEN_CENTRAL_USERNAME";
export const mavenPasswordEnv = (decl: Pick<MavenPublishDeclaration, "passwordEnv">): string => decl.passwordEnv ?? "MAVEN_CENTRAL_PASSWORD";

const CHECKSUM = /\.(md5|sha1|sha256|sha512)$/;

/** One Maven component of a bundle. */
export interface MavenComponent {
  groupId: string;
  artifactId: string;
  version: string;
  /** Its directory in the bundle. */
  dir: string;
  pom: Buffer;
  /** Its files in the bundle, by path. */
  files: string[];
  /** The SBOM file it carries, if any. */
  sbom: string | null;
}

/** The components of a bundle's files, keyed by path. */
export function mavenComponents(files: ReadonlyMap<string, Buffer>): MavenComponent[] {
  const out: MavenComponent[] = [];
  for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const m = /^(.+)\/([^/]+)\/([^/]+)\/([^/]+)\.pom$/.exec(path);
    if (!m || m[4] !== `${m[2]}-${m[3]}`) continue;
    const dir = `${m[1]}/${m[2]}/${m[3]}`;
    const own = [...files.keys()].filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/")).sort();
    out.push({ groupId: m[1]!.split("/").join("."), artifactId: m[2]!, version: m[3]!, dir, pom: bytes, files: own, sbom: own.find((f) => /-(cyclonedx\.(json|xml)|spdx\.json)$/.test(f)) ?? null });
  }
  return out;
}

/** The `groupId:artifactId` of each dependency a `.pom` needs at compile or run time. */
export function pomDependencies(pom: string): string[] {
  const body = pom.replace(/<!--[\s\S]*?-->/g, "").replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "").replace(/<build>[\s\S]*?<\/build>/g, "").replace(/<profiles>[\s\S]*?<\/profiles>/g, "");
  const out = new Set<string>();
  for (const d of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const get = (tag: string) => new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(d[1]!)?.[1];
    const scope = get("scope") ?? "compile";
    if (scope === "test" || scope === "provided" || scope === "system" || get("optional") === "true") continue;
    const g = get("groupId");
    const a = get("artifactId");
    if (g && a && !g.includes("${")) out.add(`${g}:${a}`);
  }
  return [...out];
}

const hex = (algo: string, bytes: Buffer) => createHash(algo).update(bytes).digest("hex");

/** Every file under `abs`, by its path from `abs` with `/` between parts. */
function walk(abs: string, base = abs): string[] {
  return readdirSync(abs)
    .sort()
    .flatMap((n) => {
      const p = join(abs, n);
      return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p).split("\\").join("/")];
    });
}

/** The bundle a declaration names, read: the zip to upload and its components. */
export function readMavenBundle(ctx: Pick<PublishContext, "cwd" | "release">, bundle: string): { path: string; zip: Buffer; digest: string; files: Map<string, Buffer>; components: MavenComponent[] } {
  const paths = expandArtifactAssets(ctx.release, [bundle]);
  if (paths.length !== 1) throw new PublishTargetError("publish-maven-bundle", `${bundle} is ${paths.length} files, and a maven target uploads one bundle`, "Have the build write one .zip, or name the directory in Maven repository layout.");
  const path = paths[0]!;
  const abs = memberFile(ctx.cwd, path);
  const files = new Map<string, Buffer>();
  let zip: Buffer;
  if (statSync(abs).isDirectory()) {
    for (const f of walk(abs)) {
      const bytes = readFileSync(join(abs, f));
      checkReleaseDigest(ctx.release, "asset", ctx.cwd, join(path, f), [bytesDigest(new Uint8Array(bytes))]);
      files.set(f, bytes);
    }
    for (const [f, bytes] of [...files.entries()]) {
      if (CHECKSUM.test(f) || f.endsWith(".asc")) continue;
      if (!files.has(`${f}.md5`)) files.set(`${f}.md5`, Buffer.from(hex("md5", bytes)));
      if (!files.has(`${f}.sha1`)) files.set(`${f}.sha1`, Buffer.from(hex("sha1", bytes)));
    }
    zip = zipArchive([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({ name, bytes })), 315532800);
  } else {
    zip = readFileSync(abs);
    checkReleaseDigest(ctx.release, "asset", ctx.cwd, path, [bytesDigest(new Uint8Array(zip))]);
    try {
      for (const n of zipEntryNames(zip)) if (!n.endsWith("/")) files.set(n, zipEntry(zip, n) ?? Buffer.alloc(0));
    } catch (err) {
      throw new PublishTargetError("publish-maven-bundle", `${path} is not a zip chant can read: ${err instanceof Error ? err.message : String(err)}`, "Name a .zip in Maven repository layout, or the directory itself.");
    }
  }
  const components = mavenComponents(files);
  if (components.length === 0) {
    throw new PublishTargetError("publish-maven-no-components", `${path} holds no component: no <group path>/<artifactId>/<version>/<artifactId>-<version>.pom`, "Point bundle at a Maven repository layout, such as the directory mvn deploy -DaltDeploymentRepository=local::file:./target/staging-deploy writes.");
  }
  for (const c of components) {
    if (c.version.endsWith("-SNAPSHOT")) throw new PublishTargetError("publish-maven-snapshot", `${c.groupId}:${c.artifactId}:${c.version} is a snapshot, and Maven Central publishes releases`, "Build the release's version, such as the release's label.");
    const unsigned = c.files.filter((f) => !CHECKSUM.test(f) && !f.endsWith(".asc") && !files.has(`${f}.asc`));
    if (unsigned.length > 0) {
      throw new PublishTargetError("publish-maven-unsigned", `${unsigned.join(", ")} ${unsigned.length === 1 ? "has" : "have"} no .asc signature beside ${unsigned.length === 1 ? "it" : "them"}, and Maven Central takes only signed files`, "Sign the files with GPG in the build, such as with maven-gpg-plugin, and publish the key's public half to a keyserver.");
    }
  }
  return { path, zip, digest: bytesDigest(new Uint8Array(zip)), files, components };
}

const coordinate = (c: Pick<MavenComponent, "groupId" | "artifactId" | "version">) => `${c.groupId}:${c.artifactId}@${c.version}`;

export function mavenTarget(decl: MavenPublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const api = (decl.api ?? CENTRAL_PORTAL).replace(/\/+$/, "");
  const repository = (decl.repository ?? MAVEN_CENTRAL_REPOSITORY).replace(/\/*$/, "/");
  const userName = mavenUsernameEnv(decl);
  const passName = mavenPasswordEnv(decl);
  const label = decl.api ? new URL(api).host : "Maven Central";

  const read = (ctx: PublishContext) => {
    const b = readMavenBundle(ctx, decl.bundle);
    if (ctx.requireSbom && decl.sbom !== false) {
      const without = b.components.find((c) => c.sbom === null);
      if (without) {
        throw new PublishTargetError(
          "publish-sbom-missing",
          `${without.groupId}:${without.artifactId}:${without.version} carries no SBOM: Maven Central keeps an SBOM as a file of the component, such as ${without.artifactId}-${without.version}-cyclonedx.json`,
          "Attach one in the build, such as with cyclonedx-maven-plugin, or set sbom: false to publish without one.",
        );
      }
    }
    return b;
  };

  const items = (cs: MavenComponent[]): PublishItem[] =>
    cs.map((c) => ({ name: coordinate(c), destination: `${CENTRAL_PORTAL}/artifact/${c.groupId}/${c.artifactId}/${c.version}`, digest: bytesDigest(new Uint8Array(c.pom)), ...(c.sbom ? { sbom: c.sbom.split("/").pop()! } : {}) }));

  const authorization = (ctx: PublishContextBase): string => {
    const user = readCredential(ctx.env, [userName], ctx.redactor);
    const pass = readCredential(ctx.env, [passName], ctx.redactor);
    if (!user || !pass) {
      throw new PublishTargetError(
        "publish-credentials-missing",
        `the ${label} target reads a Central Portal user token from ${userName} and ${passName}, and ${[!user ? userName : null, !pass ? passName : null].filter(Boolean).join(" and ")} ${!user && !pass ? "are" : "is"} not set`,
        `Generate a user token at ${CENTRAL_PORTAL}/account and set ${userName} to its name and ${passName} to its password.`,
      );
    }
    const bearer = Buffer.from(`${user.value}:${pass.value}`, "utf-8").toString("base64");
    ctx.redactor.add(bearer);
    return `Bearer ${bearer}`;
  };

  const fail = (ctx: PublishContextBase, code: string, what: string, status: number, text: string, fix?: string): never => {
    throw new PublishTargetError(code, ctx.redactor.redact(`${what} on ${label} answered ${status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 300)}` : ""}`), fix);
  };

  const pomUrl = (c: Pick<MavenComponent, "groupId" | "artifactId" | "version">) => `${repository}${c.groupId.split(".").join("/")}/${c.artifactId}/${c.version}/${c.artifactId}-${c.version}.pom`;

  /** The `.pom` the repository serves for a component, or null. */
  const served = async (ctx: PublishContextBase, c: Pick<MavenComponent, "groupId" | "artifactId" | "version">): Promise<Buffer | null> => {
    const url = pomUrl(c);
    const res = await fetchImpl(url, { method: "GET", headers: { "user-agent": "chant" } });
    if (res.status === 404) return null;
    if (res.status !== 200) fail(ctx, "publish-maven-failed", `reading ${url}`, res.status, await res.text().catch(() => ""));
    return res.arrayBuffer ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text(), "utf-8");
  };

  /** True when every component is published with the same `.pom`; false when none is; refused otherwise. */
  const published = async (ctx: PublishContextBase, cs: MavenComponent[]): Promise<boolean> => {
    const there: string[] = [];
    for (const c of cs) {
      const pom = await served(ctx, c);
      if (pom === null) continue;
      if (!pom.equals(c.pom)) throw new PublishTargetError("publish-maven-version-exists", `${label} already has ${c.groupId}:${c.artifactId}:${c.version}, with another .pom`, "Maven Central never takes a version twice: cut a release with a new version.");
      there.push(coordinate(c));
    }
    if (there.length === 0) return false;
    if (there.length === cs.length) return true;
    throw new PublishTargetError(
      "publish-maven-version-exists",
      `${label} already has ${there.join(", ")}, and not ${cs.map(coordinate).filter((n) => !there.includes(n)).join(", ")}; a deployment that holds a published component fails validation`,
      "Leave the published components out of the bundle, or cut a release with a new version.",
    );
  };

  /** The deployment's state and errors, or null when the Portal has no such deployment. */
  const status = async (ctx: PublishContextBase, auth: string, id: string): Promise<{ state: string; errors: string } | null> => {
    const url = `${api}/api/v1/publisher/status?id=${encodeURIComponent(id)}`;
    const res = await fetchImpl(url, { method: "POST", headers: { "user-agent": "chant", accept: "application/json", authorization: auth } });
    const text = await res.text().catch(() => "");
    if (res.status === 404) return null;
    if (res.status !== 200) fail(ctx, "publish-maven-failed", `reading deployment ${id}`, res.status, text);
    try {
      const body = JSON.parse(text) as { deploymentState?: unknown; errors?: unknown };
      return { state: typeof body.deploymentState === "string" ? body.deploymentState : "UNKNOWN", errors: body.errors === undefined ? "" : JSON.stringify(body.errors) };
    } catch {
      return fail(ctx, "publish-maven-failed", `reading deployment ${id}`, res.status, "not JSON");
    }
  };

  /** Wait until the Portal is done validating; refuses `FAILED` and a wait past the cap. */
  const validated = async (ctx: PublishContextBase, auth: string, id: string): Promise<string> => {
    const start = now();
    let logged: number | undefined;
    for (;;) {
      const s = await status(ctx, auth, id);
      if (s === null) throw new PublishTargetError("publish-maven-deployment-missing", `${label} has no deployment ${id}: it was dropped`, "Cut a release with a new version, or upload the bundle in the Central Portal by hand.");
      if (s.state === "FAILED") {
        throw new PublishTargetError("publish-maven-invalid", ctx.redactor.redact(`${label} refused deployment ${id}${s.errors ? `: ${s.errors.slice(0, 600)}` : ""}`), `Fix the bundle and cut a new release. The deployment stays in the Central Portal at ${CENTRAL_PORTAL}/publishing/deployments, where it can be read and dropped.`);
      }
      if (s.state !== "PENDING" && s.state !== "VALIDATING") return s.state;
      if (now() - start >= MAVEN_VALIDATION_WAIT_MS) {
        throw new PublishTargetError("publish-maven-validation-timeout", `${label} did not validate deployment ${id} within ${Math.round(MAVEN_VALIDATION_WAIT_MS / 60_000)} minutes`, "Run the same publish again: it waits on the same deployment and uploads nothing twice.");
      }
      if (logged === undefined || now() - logged >= 60_000) {
        ctx.log(`waiting for ${label} to validate deployment ${id} (${s.state})`);
        logged = now();
      }
      await sleep(MAVEN_STATUS_POLL_MS);
    }
  };

  const target: PublishTarget = {
    kind: "maven",
    name: `${label} ${decl.bundle}`,
    destination: label,
    credentialEnv: [userName, passName],
    key: publishTargetKey(decl),
    async names(ctx) {
      const { components } = readMavenBundle(ctx, decl.bundle);
      const provides = components.map((c) => trainName("maven", `${c.groupId}:${c.artifactId}`));
      const needs = new Set(components.flatMap((c) => pomDependencies(c.pom.toString("utf-8")).map((d) => trainName("maven", d))));
      return { provides, needs: [...needs].filter((n) => !provides.includes(n)) };
    },
    /** #5165: whether the repository serves each component's `.pom` at the release's version. */
    async published(ctx) {
      const version = releaseVersion(ctx.label);
      if (!version) return null;
      let components: MavenComponent[];
      try {
        components = readMavenBundle(ctx, decl.bundle).components;
      } catch {
        return null;
      }
      for (const c of components) if ((await served(ctx, { ...c, version })) === null) return false;
      return true;
    },
    /** #5165: wait until the repository serves each component the reveal published. */
    async visible(ctx, done) {
      const cs = done.items.filter((i) => i.attachment === undefined && !i.refused).map((i) => /^([^:]+):([^@]+)@(.+)$/.exec(i.name)).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ groupId: m[1]!, artifactId: m[2]!, version: m[3]! }));
      if (cs.length === 0) return;
      await waitUntilServed(ctx, deps, {
        what: label,
        code: "publish-maven-not-served",
        capMs: MAVEN_VISIBLE_WAIT_MS,
        check: async () => {
          const missing: string[] = [];
          for (const c of cs) if ((await served(ctx, c)) === null) missing.push(coordinate(c));
          return missing;
        },
      });
    },
    async plan(ctx) {
      const b = read(ctx);
      authorization(ctx);
      return items(b.components);
    },
    async stage(ctx) {
      const b = read(ctx);
      const auth = authorization(ctx);
      if (await published(ctx, b.components)) {
        ctx.log(`${label} already has every component with the same .pom`);
        const staged: StagedTarget = { target: target.name, destination: target.destination, items: items(b.components).map((i) => ({ ...i, present: true })), state: { present: "true" } };
        return staged;
      }
      const boundary = `chant-${randomBytes(12).toString("hex")}`;
      const name = `${b.components[0]!.groupId}:${b.components[0]!.artifactId}:${b.components[0]!.version}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.zip"\r\nContent-Type: application/octet-stream\r\n\r\n`, "utf-8"),
        b.zip,
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"),
      ]);
      ctx.log(`uploading ${b.path} (${b.zip.byteLength} bytes, ${b.components.length} component${b.components.length === 1 ? "" : "s"}) to ${label}, held for the reveal to publish`);
      const res = await fetchImpl(`${api}/api/v1/publisher/upload?publishingType=USER_MANAGED&name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "user-agent": "chant", "content-type": `multipart/form-data; boundary=${boundary}`, authorization: auth },
        body: new Uint8Array(body),
      });
      const text = (await res.text().catch(() => "")).trim();
      if (res.status !== 200 && res.status !== 201) fail(ctx, "publish-maven-failed", "uploading the bundle", res.status, text, res.status === 401 || res.status === 403 ? `Check the user token in ${userName} and ${passName}, and that its account owns the namespace ${b.components[0]!.groupId}.` : undefined);
      const id = text.replace(/^"|"$/g, "");
      if (!id) fail(ctx, "publish-maven-failed", "uploading the bundle", res.status, "no deployment id");
      ctx.log(`${label} took the bundle as deployment ${id}`);
      const state = await validated(ctx, auth, id);
      ctx.log(`${label} validated deployment ${id} (${state}); the reveal publishes it`);
      const staged: StagedTarget = { target: target.name, destination: target.destination, items: items(b.components), state: { deployment: id } };
      return staged;
    },
    async reveal(ctx, staged) {
      if (staged.state.present === "true") return { target: target.name, destination: target.destination, items: staged.items.map((i) => ({ ...i, present: true })) };
      const id = staged.state.deployment;
      if (!id) throw new PublishTargetError("publish-maven-deployment-missing", "the stage recorded no deployment to publish", "Cut a release with a new version.");
      const auth = authorization(ctx);
      const state = await validated(ctx, auth, id);
      if (state === "PUBLISHING" || state === "PUBLISHED") {
        ctx.log(`${label} already publishes deployment ${id} (${state})`);
      } else {
        ctx.log(`publishing deployment ${id} on ${label}`);
        const res = await fetchImpl(`${api}/api/v1/publisher/deployment/${encodeURIComponent(id)}`, { method: "POST", headers: { "user-agent": "chant", authorization: auth } });
        const text = await res.text().catch(() => "");
        if (res.status < 200 || res.status > 299) fail(ctx, "publish-maven-failed", `publishing deployment ${id}`, res.status, text);
        ctx.log(`${label} is publishing deployment ${id}; the repository serves it within about half an hour`);
      }
      return { target: target.name, destination: target.destination, items: staged.items };
    },
  };
  return target;
}
