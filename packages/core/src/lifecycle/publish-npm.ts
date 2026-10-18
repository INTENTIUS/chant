/**
 * The npm publish target (#4047): `npm publish` for each package the
 * declaration lists, in the order it lists them, so a set of packages that
 * depend on each other goes out dependencies first.
 *
 * Each package is a directory with a `package.json` or a `.tgz` that
 * `npm pack` wrote, relative to the member. The command is
 *
 *     npm publish <package> [--registry <url>] [--access <access>] [--tag <tag>] [--provenance]
 *
 * `--provenance` is passed when the run has an OIDC token (`detectProvenance`
 * in ./release-publish.ts), so a CI publish gets npm provenance, and npm's
 * trusted publishing exchanges that token for its own. `--tag` is the
 * context's tag, which #4048 uses to stage a set under a dist-tag; without it
 * npm uses `latest`.
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
import { checkReleaseDigest, fileDigest, isDir, memberFile } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishItem, type PublishTarget } from "./release-publish";

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

/** The arguments of one `npm publish`. */
export function npmPublishArgs(decl: Pick<NpmPublishDeclaration, "registry" | "access">, abs: string, ctx: Pick<PublishContext, "tag" | "provenance">): string[] {
  return [
    "publish",
    abs,
    ...(decl.registry ? ["--registry", decl.registry] : []),
    ...(decl.access ? ["--access", decl.access] : []),
    ...(ctx.tag ? ["--tag", ctx.tag] : []),
    ...(ctx.provenance.oidc ? ["--provenance"] : []),
  ];
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
  const plan = async (ctx: PublishContext): Promise<PublishItem[]> =>
    decl.packages.map((p) => {
      const pkg = readPackage(ctx, p);
      return { name: `${pkg.name}@${pkg.version}`, destination: `${registry}, dist-tag ${ctx.tag ?? "latest"}`, ...(pkg.digest ? { digest: pkg.digest } : {}) };
    });
  return {
    kind: "npm",
    name: `npm (${decl.packages.length} package${decl.packages.length === 1 ? "" : "s"})`,
    destination: `npm ${registry}`,
    credentialEnv: [],
    plan,
    async publish(ctx) {
      const pkgs = decl.packages.map((p) => readPackage(ctx, p));
      const items: PublishItem[] = [];
      for (const pkg of pkgs) {
        const args = npmPublishArgs(decl, pkg.abs, ctx);
        ctx.log(`npm publish ${pkg.path}${args.slice(2).length > 0 ? ` ${args.slice(2).join(" ")}` : ""}`);
        let result: { code: number; output: string[] };
        try {
          result = await run(bin, args, ctx);
        } catch (err) {
          throw new PublishTargetError("publish-npm-failed", ctx.redactor.redact(`npm could not be run: ${err instanceof Error ? err.message : String(err)}`), "Install npm, or put it on PATH.");
        }
        for (const line of result.output) ctx.log(`  ${line}`);
        if (result.code !== 0) {
          const done = items.map((i) => i.name);
          throw new PublishTargetError(
            "publish-npm-failed",
            `npm publish of ${pkg.name}@${pkg.version} exited ${result.code}${done.length > 0 ? `, after ${done.join(", ")} were published` : ", before any package was published"}: ${result.output.at(-1) ?? "npm printed nothing"}`,
          );
        }
        items.push({ name: `${pkg.name}@${pkg.version}`, destination: `${registry}, dist-tag ${ctx.tag ?? "latest"}`, ...(pkg.digest ? { digest: pkg.digest } : {}) });
      }
      return { target: this.name, destination: this.destination, items };
    },
  };
}
