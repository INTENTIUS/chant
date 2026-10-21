/**
 * The npm publish target (#4047): `npm publish` for each package the
 * declaration lists, in the order it lists them, so a set of packages that
 * depend on each other goes out dependencies first.
 *
 * Each package is a directory with a `package.json` or a `.tgz` that
 * `npm pack` wrote, relative to the member.
 *
 * A publish is two steps (#4048), as chant's own releases are (#3903):
 *
 * - stage: for each package, `npm view <name>@<version> version` asks the
 *   registry whether it already holds the version, and when it does not,
 *
 *       npm publish <package> --tag next [--registry <url>] [--access <access>] [--provenance]
 *
 *   puts it out under the `next` dist-tag, where nothing that resolves
 *   `latest` or a range finds it. A version already there is not published
 *   again, so a stage run after a failure publishes only the rest.
 * - reveal: `npm dist-tag add <name>@<version> latest` for each package in
 *   the declared order. The first package is the set's core: it moves first,
 *   so a consumer never resolves a new package whose new core is not `latest`
 *   yet. Order the list core first, then the packages that depend on it.
 *   `ctx.tag` names another tag to move in place of `latest`.
 *
 * `--provenance` is passed when the run has an OIDC token (`detectProvenance`
 * in ./release-publish.ts), so a CI publish gets npm provenance, and npm's
 * trusted publishing exchanges that token for its own. With that token, the
 * reveal then checks what it published (#4049): in an empty directory it
 * installs every package at its version with `npm install --ignore-scripts`
 * and runs `npm audit signatures`, which fails on a package whose registry
 * signature or provenance attestation does not verify. From a workstation
 * there is no npm provenance, and the release's signature, which
 * `chant release verify` checks, is the only provenance.
 *
 * Each package carries its SBOM (#4049): npm keeps no file beside a package,
 * so the SBOM is a file at the package's root, the one `sbom` names or the
 * first of `sbom.spdx.json`, `sbom.cdx.json`, `sbom.cyclonedx.json` it holds,
 * such as `npm sbom` writes. A package with none publishes without one,
 * except under the `supply-chain` group (#4168) or when `sbom` names a file,
 * where it is refused (`publish-sbom-missing`). Moving a dist-tag over
 * OIDC needs "Allow npm dist-tag" on the package's trusted-publisher record.
 * npm makes the first version of a new package `latest` whatever tag it is
 * published under, so a package's first release is visible when it stages.
 *
 * Credentials are npm's own. chant reads no npm token and writes no `.npmrc`:
 * npm authenticates with the registry's `_authToken` in the user's or the
 * CI's npm config (`actions/setup-node` writes one that reads
 * `NODE_AUTH_TOKEN`), or by trusted publishing. npm runs with the run's
 * environment, and everything it prints is redacted before chant prints it.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageSbom } from "./publish-attachments";
import type { NpmPublishDeclaration } from "./publish-declaration";
import { checkReleaseDigest, fileDigest, isDir, memberFile, publishTargetKey } from "./publish-targets";
import { NPM_STAGE_TAG, PublishTargetError, type PublishContext, type PublishDeps, type PublishItem, type PublishTarget } from "./release-publish";

interface NpmPackage {
  path: string;
  abs: string;
  name: string;
  version: string;
  digest?: string;
  /** The SBOM file at its root, or undefined under `sbom: false`. */
  sbom?: string;
}

/** Read a package's name and version, from its directory or its packed `.tgz`, and find the SBOM it carries. */
function readPackage(ctx: PublishContext, path: string, sbom: NpmPublishDeclaration["sbom"]): NpmPackage {
  const abs = memberFile(ctx.cwd, path);
  let text: string;
  let digest: string | undefined;
  const directory = isDir(abs);
  if (directory) {
    try {
      text = readFileSync(join(abs, "package.json"), "utf-8");
    } catch {
      throw new PublishTargetError("publish-npm-not-a-package", `${path} has no package.json`);
    }
  } else {
    digest = fileDigest(abs);
    checkReleaseDigest(ctx.release, "asset", ctx.cwd, path, [digest]);
    try {
      text = execFileSync("tar", ["-xzOf", abs, "package/package.json"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      throw new PublishTargetError("publish-npm-not-a-package", `${path} is not a package tarball with package/package.json`);
    }
  }
  let pkg: { name?: unknown; version?: unknown; private?: unknown };
  try {
    pkg = JSON.parse(text);
  } catch {
    throw new PublishTargetError("publish-npm-not-a-package", `${path}'s package.json is not JSON`);
  }
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
    throw new PublishTargetError("publish-npm-not-a-package", `${path}'s package.json has no name and version`);
  }
  if (pkg.private === true) {
    throw new PublishTargetError("publish-npm-private", `${pkg.name} (${path}) is private, and npm refuses to publish it`, "Remove it from release.publish, or remove private: true.");
  }
  const carried = packageSbom(abs, directory, path, pkg.name, sbom, ctx.requireSbom === true);
  return { path, abs, name: pkg.name, version: pkg.version, ...(digest ? { digest } : {}), ...(carried ? { sbom: carried.file } : {}) };
}

/** The arguments of one `npm publish`, which stages under `tag`. */
export function npmPublishArgs(decl: Pick<NpmPublishDeclaration, "registry" | "access">, abs: string, ctx: Pick<PublishContext, "provenance">, tag: string = NPM_STAGE_TAG): string[] {
  return [
    "publish",
    abs,
    "--tag",
    tag,
    ...(decl.registry ? ["--registry", decl.registry] : []),
    ...(decl.access ? ["--access", decl.access] : []),
    ...(ctx.provenance.oidc ? ["--provenance"] : []),
  ];
}

/** The arguments of the `npm dist-tag add` that reveals a staged version under `tag`. */
export function npmDistTagArgs(decl: Pick<NpmPublishDeclaration, "registry">, name: string, version: string, tag: string): string[] {
  return ["dist-tag", "add", `${name}@${version}`, tag, ...(decl.registry ? ["--registry", decl.registry] : [])];
}

/** The arguments of the `npm install` that fetches the published packages into an empty directory for `npm audit signatures`. */
export function npmAuditInstallArgs(decl: Pick<NpmPublishDeclaration, "registry">): string[] {
  return ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...(decl.registry ? ["--registry", decl.registry] : [])];
}

/** The arguments of `npm audit signatures`. */
export function npmAuditSignaturesArgs(decl: Pick<NpmPublishDeclaration, "registry">): string[] {
  return ["audit", "signatures", ...(decl.registry ? ["--registry", decl.registry] : [])];
}

function run(bin: string, args: string[], ctx: PublishContext, cwd: string = ctx.cwd): Promise<{ code: number; output: string[] }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd, env: ctx.env, stdio: ["ignore", "pipe", "pipe"] });
    const output: string[] = [];
    let partial = { out: "", err: "" };
    const take = (key: "out" | "err") => (chunk: Buffer) => {
      const text = partial[key] + chunk.toString("utf-8");
      const lines = text.split("\n");
      partial = { ...partial, [key]: lines.pop() ?? "" };
      for (const l of lines) if (l.trim() !== "") output.push(ctx.redactor.redact(l));
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    child.on("error", reject);
    child.on("close", (code) => {
      for (const l of [partial.out, partial.err]) if (l.trim() !== "") output.push(ctx.redactor.redact(l));
      resolvePromise({ code: code ?? 1, output });
    });
  });
}

export function npmTarget(decl: NpmPublishDeclaration, deps: PublishDeps): PublishTarget {
  const bin = deps.npm ?? "npm";
  const registry = decl.registry ?? "the registry npm's config names";
  const shown = (tag: string) => `${registry}, dist-tag ${tag}`;
  const revealTag = (ctx: PublishContext) => ctx.tag ?? "latest";
  // Under `stage: false` a package goes straight to the reveal tag, and the reveal moves no tag (#4040).
  const staging = decl.stage !== false;
  const stageTag = (ctx: PublishContext) => (staging ? NPM_STAGE_TAG : revealTag(ctx));
  const npm = async (ctx: PublishContext, args: string[], cwd?: string): Promise<{ code: number; output: string[] }> => {
    try {
      return await run(bin, args, ctx, cwd);
    } catch (err) {
      throw new PublishTargetError("publish-npm-failed", ctx.redactor.redact(`npm could not be run: ${err instanceof Error ? err.message : String(err)}`), "Install npm, or put it on PATH.");
    }
  };
  /** Whether the registry already holds the version. A failed lookup reads as no, and the publish that follows says why. */
  const onRegistry = async (ctx: PublishContext, pkg: NpmPackage): Promise<boolean> => {
    const r = await npm(ctx, ["view", `${pkg.name}@${pkg.version}`, "version", ...(decl.registry ? ["--registry", decl.registry] : [])]);
    return r.code === 0 && r.output.some((l) => l.trim() === pkg.version || l.trim() === JSON.stringify(pkg.version));
  };
  const read = (ctx: PublishContext) => decl.packages.map((p) => readPackage(ctx, p, decl.sbom));
  const extra = (pkg: NpmPackage) => ({ ...(pkg.digest ? { digest: pkg.digest } : {}), ...(pkg.sbom ? { sbom: pkg.sbom } : {}) });
  const plan = async (ctx: PublishContext): Promise<PublishItem[]> =>
    read(ctx).map((pkg) => ({ name: `${pkg.name}@${pkg.version}`, destination: staging ? `${shown(NPM_STAGE_TAG)}, then ${revealTag(ctx)}` : shown(revealTag(ctx)), ...extra(pkg) }));
  /**
   * In CI, install what was published into an empty directory and run
   * `npm audit signatures` there (#4049), which checks each package's
   * registry signature and provenance attestation.
   */
  const audit = async (ctx: PublishContext, pkgs: NpmPackage[]): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "chant-npm-audit-"));
    try {
      const dependencies = Object.fromEntries(pkgs.map((p) => [p.name, p.version]));
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "chant-publish-audit", version: "0.0.0", private: true, dependencies }, null, 2)}\n`);
      for (const args of [npmAuditInstallArgs(decl), npmAuditSignaturesArgs(decl)]) {
        ctx.log(`npm ${args.join(" ")}`);
        const result = await npm(ctx, args, dir);
        for (const line of result.output) ctx.log(`  ${line}`);
        if (result.code !== 0) {
          throw new PublishTargetError(
            "publish-npm-audit-failed",
            `npm ${args.slice(0, 2).join(" ")} exited ${result.code} for ${pkgs.map((p) => `${p.name}@${p.version}`).join(", ")}, after latest moved: ${result.output.at(-1) ?? "npm printed nothing"}`,
            "Each package was published; check its signature and provenance on the registry. Running the publish again moves no tag that moved and audits again.",
          );
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    kind: "npm",
    name: `npm (${decl.packages.length} package${decl.packages.length === 1 ? "" : "s"})`,
    destination: `npm ${registry}`,
    credentialEnv: [],
    key: publishTargetKey(decl),
    plan,
    async stage(ctx) {
      const pkgs = read(ctx);
      const items: PublishItem[] = [];
      for (const pkg of pkgs) {
        const item: PublishItem = { name: `${pkg.name}@${pkg.version}`, destination: shown(stageTag(ctx)), ...extra(pkg) };
        if (await onRegistry(ctx, pkg)) {
          ctx.log(`${item.name} is already on the registry; not published again`);
          items.push({ ...item, present: true });
          continue;
        }
        const args = npmPublishArgs(decl, pkg.abs, ctx, stageTag(ctx));
        ctx.log(`npm publish ${pkg.path} ${args.slice(2).join(" ")}`);
        const result = await npm(ctx, args);
        for (const line of result.output) ctx.log(`  ${line}`);
        if (result.code !== 0) {
          const done = items.map((i) => i.name);
          throw new PublishTargetError(
            "publish-npm-failed",
            `npm publish of ${item.name} exited ${result.code}${done.length > 0 ? `, after ${done.join(", ")} were ${staging ? "staged" : "published"} under ${stageTag(ctx)}` : `, before any package was ${staging ? "staged" : "published"}`}: ${result.output.at(-1) ?? "npm printed nothing"}`,
          );
        }
        items.push(item);
      }
      return { target: this.name, destination: this.destination, items, state: {} };
    },
    async reveal(ctx) {
      const tag = revealTag(ctx);
      const pkgs = read(ctx);
      const items: PublishItem[] = [];
      if (!staging) {
        // Already under the reveal tag since the stage; only the audit is left.
        if (ctx.provenance.oidc) await audit(ctx, pkgs);
        return { target: this.name, destination: this.destination, items: pkgs.map((pkg) => ({ name: `${pkg.name}@${pkg.version}`, destination: shown(tag), ...extra(pkg) })) };
      }
      // The declared order: the first package is the set's core, and its tag moves first.
      for (const pkg of pkgs) {
        const args = npmDistTagArgs(decl, pkg.name, pkg.version, tag);
        ctx.log(`npm ${args.join(" ")}`);
        const result = await npm(ctx, args);
        for (const line of result.output) ctx.log(`  ${line}`);
        if (result.code !== 0) {
          const moved = items.map((i) => i.name);
          throw new PublishTargetError(
            "publish-npm-tag-failed",
            `npm dist-tag add ${pkg.name}@${pkg.version} ${tag} exited ${result.code}${moved.length > 0 ? `, after ${tag} moved for ${moved.join(", ")}` : `, before ${tag} moved for any package`}: ${result.output.at(-1) ?? "npm printed nothing"}`,
            `Moving a dist-tag needs npm credentials that may change dist-tags; over OIDC that is "Allow npm dist-tag" on the package's trusted-publisher record.`,
          );
        }
        items.push({ name: `${pkg.name}@${pkg.version}`, destination: shown(tag), ...extra(pkg) });
      }
      if (ctx.provenance.oidc) await audit(ctx, pkgs);
      return { target: this.name, destination: this.destination, items };
    },
  };
}
