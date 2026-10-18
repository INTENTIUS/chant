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
 * trusted publishing exchanges that token for its own. Moving a dist-tag over
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NpmPublishDeclaration } from "./publish-declaration";
import { checkReleaseDigest, fileDigest, isDir, memberFile, publishTargetKey } from "./publish-targets";
import { NPM_STAGE_TAG, PublishTargetError, type PublishContext, type PublishDeps, type PublishItem, type PublishTarget } from "./release-publish";

interface NpmPackage {
  path: string;
  abs: string;
  name: string;
  version: string;
  digest?: string;
}

/** Read a package's name and version, from its directory or its packed `.tgz`. */
function readPackage(ctx: PublishContext, path: string): NpmPackage {
  const abs = memberFile(ctx.cwd, path);
  let text: string;
  let digest: string | undefined;
  if (isDir(abs)) {
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
  return { path, abs, name: pkg.name, version: pkg.version, ...(digest ? { digest } : {}) };
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

function run(bin: string, args: string[], ctx: PublishContext): Promise<{ code: number; output: string[] }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: ctx.cwd, env: ctx.env, stdio: ["ignore", "pipe", "pipe"] });
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
  const npm = async (ctx: PublishContext, args: string[]): Promise<{ code: number; output: string[] }> => {
    try {
      return await run(bin, args, ctx);
    } catch (err) {
      throw new PublishTargetError("publish-npm-failed", ctx.redactor.redact(`npm could not be run: ${err instanceof Error ? err.message : String(err)}`), "Install npm, or put it on PATH.");
    }
  };
  /** Whether the registry already holds the version. A failed lookup reads as no, and the publish that follows says why. */
  const onRegistry = async (ctx: PublishContext, pkg: NpmPackage): Promise<boolean> => {
    const r = await npm(ctx, ["view", `${pkg.name}@${pkg.version}`, "version", ...(decl.registry ? ["--registry", decl.registry] : [])]);
    return r.code === 0 && r.output.some((l) => l.trim() === pkg.version || l.trim() === JSON.stringify(pkg.version));
  };
  const plan = async (ctx: PublishContext): Promise<PublishItem[]> =>
    decl.packages.map((p) => {
      const pkg = readPackage(ctx, p);
      return { name: `${pkg.name}@${pkg.version}`, destination: `${shown(NPM_STAGE_TAG)}, then ${revealTag(ctx)}`, ...(pkg.digest ? { digest: pkg.digest } : {}) };
    });
  return {
    kind: "npm",
    name: `npm (${decl.packages.length} package${decl.packages.length === 1 ? "" : "s"})`,
    destination: `npm ${registry}`,
    credentialEnv: [],
    key: publishTargetKey(decl),
    plan,
    async stage(ctx) {
      const pkgs = decl.packages.map((p) => readPackage(ctx, p));
      const items: PublishItem[] = [];
      for (const pkg of pkgs) {
        const item: PublishItem = { name: `${pkg.name}@${pkg.version}`, destination: shown(NPM_STAGE_TAG), ...(pkg.digest ? { digest: pkg.digest } : {}) };
        if (await onRegistry(ctx, pkg)) {
          ctx.log(`${item.name} is already on the registry; not published again`);
          items.push({ ...item, present: true });
          continue;
        }
        const args = npmPublishArgs(decl, pkg.abs, ctx);
        ctx.log(`npm publish ${pkg.path} ${args.slice(2).join(" ")}`);
        const result = await npm(ctx, args);
        for (const line of result.output) ctx.log(`  ${line}`);
        if (result.code !== 0) {
          const done = items.map((i) => i.name);
          throw new PublishTargetError(
            "publish-npm-failed",
            `npm publish of ${item.name} exited ${result.code}${done.length > 0 ? `, after ${done.join(", ")} were staged under ${NPM_STAGE_TAG}` : ", before any package was staged"}: ${result.output.at(-1) ?? "npm printed nothing"}`,
          );
        }
        items.push(item);
      }
      return { target: this.name, destination: this.destination, items, state: {} };
    },
    async reveal(ctx) {
      const tag = revealTag(ctx);
      const pkgs = decl.packages.map((p) => readPackage(ctx, p));
      const items: PublishItem[] = [];
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
        items.push({ name: `${pkg.name}@${pkg.version}`, destination: shown(tag), ...(pkg.digest ? { digest: pkg.digest } : {}) });
      }
      return { target: this.name, destination: this.destination, items };
    },
  };
}
