/**
 * The cargo target (#5167): Rust crates published to crates.io or another
 * Cargo registry with `cargo publish`, one crate at a time, each after the
 * workspace crates it depends on.
 *
 * The crates and their versions come from `cargo metadata --no-deps` on the
 * declared manifest: the ones `crates` names, else every workspace member
 * whose `publish` allows the registry. The version published is the one in
 * each `Cargo.toml`, which `release.version` can stamp with the release's
 * label. A crate's dependency on another workspace crate needs a version
 * beside its path, or cargo refuses to publish it, so the plan refuses it
 * first (`publish-cargo-dependency-version`).
 *
 * A registry has no draft: a crate version is visible as soon as it is
 * published, and a version can never be published twice. So the stage
 * publishes nothing. It reads the registry's sparse index for each crate,
 * and a version already there is `present`. The reveal reads the index
 * again before each crate, so a reveal run again after a failure part way
 * publishes only the crates that are not there yet, and then runs
 *
 *     cargo publish -p <crate> --manifest-path <manifest> --no-verify --allow-dirty [--registry <name>]
 *
 * in dependency order. `--no-verify` because a publish never builds: the
 * build belongs to the cut. `--allow-dirty` because the checkout carries the
 * stamped versions, which the publish's own checkout check already allows.
 * cargo waits until the registry's index serves each crate before it
 * returns, so the next crate resolves it. Nothing is out between the stage
 * and the reveal, so a check of what staged can't see this target.
 *
 * Credentials:
 *
 * - `auth: "token"`: a token from `tokenEnv` (default `CARGO_REGISTRY_TOKEN`,
 *   or `CARGO_REGISTRIES_<NAME>_TOKEN` with `registry`), handed to cargo in
 *   the variable it reads.
 * - `auth: "trusted-publishing"`, crates.io only: the run's OIDC ID token
 *   (audience `crates.io`, from GitHub Actions or `CRATES_IO_ID_TOKEN`) is
 *   exchanged at `POST {api}/api/v1/trusted_publishing/tokens` for a token
 *   that lasts minutes, and revoked with a `DELETE` when the step ends. The
 *   stage exchanges and revokes one to check that crates.io takes this
 *   workflow as a trusted publisher.
 *
 * Unset, `auth` is a token when the token's variable is set, else trusted
 * publishing when the run has an OIDC ID token.
 *
 * A registry keeps no file beside a crate, so nothing is attached. Under the
 * `supply-chain` group the target is refused (`publish-sbom-missing`) unless
 * `sbom` is `false`.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readCredential } from "./publish-credentials";
import type { CargoPublishDeclaration } from "./publish-declaration";
import { hasIdToken, memberFile, publishTargetKey, runIdToken } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget } from "./release-publish";

/** The first chant that publishes a `cargo` target (#5167). */
export const PUBLISH_CARGO_FLOOR = "0.124.101";

export const CRATES_IO_INDEX = "https://index.crates.io/";
export const CRATES_IO_API = "https://crates.io";
/** The variable an OIDC ID token for crates.io is read from outside GitHub Actions. */
export const CRATES_IO_ID_TOKEN_ENV = "CRATES_IO_ID_TOKEN";
/** The audience crates.io takes an OIDC ID token for. */
export const CRATES_IO_AUDIENCE = "crates.io";

/** The variable cargo reads a registry's token from. */
export function cargoRegistryTokenVar(registry: string | undefined): string {
  return registry ? `CARGO_REGISTRIES_${registry.toUpperCase().replace(/-/g, "_")}_TOKEN` : "CARGO_REGISTRY_TOKEN";
}

/** The variable the declaration's token is read from. */
export function cargoTokenEnv(decl: Pick<CargoPublishDeclaration, "registry" | "tokenEnv">): string {
  return decl.tokenEnv ?? cargoRegistryTokenVar(decl.registry);
}

/** How the target authenticates in `env`. */
export function cargoAuth(decl: CargoPublishDeclaration, env: NodeJS.ProcessEnv): "token" | "trusted-publishing" {
  if (decl.auth) return decl.auth;
  if (env[cargoTokenEnv(decl)]) return "token";
  return decl.registry === undefined && hasIdToken(env, CRATES_IO_ID_TOKEN_ENV) ? "trusted-publishing" : "token";
}

/** A crate's file in a sparse index, by Cargo's layout. */
export function sparseIndexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

/** One workspace crate, as `cargo metadata` gives it. */
export interface CargoCrate {
  name: string;
  version: string;
  /** null: any registry; []: none. */
  publish: string[] | null;
  dependencies: Array<{ name: string; req: string; kind: string | null; path?: string }>;
}

/**
 * The crates to publish, each after the selected crates it depends on (ties
 * in name order). A dev-dependency with no version is left out of the order,
 * since cargo drops it from what it publishes.
 */
export function cargoPublishOrder(all: readonly CargoCrate[], decl: Pick<CargoPublishDeclaration, "crates" | "registry">): CargoCrate[] {
  const registryName = decl.registry ?? "crates-io";
  const byName = new Map(all.map((c) => [c.name, c]));
  let chosen: CargoCrate[];
  if (decl.crates) {
    chosen = decl.crates.map((n) => {
      const c = byName.get(n);
      if (!c) throw new PublishTargetError("publish-cargo-unknown-crate", `crates names ${n}, and the workspace has no such crate: it has ${[...byName.keys()].sort().join(", ") || "none"}`, "Name the crates by their package name in Cargo.toml.");
      if (c.publish !== null && !c.publish.includes(registryName)) {
        throw new PublishTargetError("publish-cargo-unpublishable", `${n}'s Cargo.toml has publish = ${JSON.stringify(c.publish)}, which leaves out ${registryName}`, `Take ${n} out of crates, or allow ${registryName} in its publish field.`);
      }
      return c;
    });
  } else {
    chosen = all.filter((c) => c.publish === null || c.publish.includes(registryName));
    if (chosen.length === 0) throw new PublishTargetError("publish-cargo-no-crates", `no crate of the workspace may be published to ${registryName}: each has publish = false or names other registries`);
  }
  const names = new Set(chosen.map((c) => c.name));
  const workspace = new Set(all.map((c) => c.name));
  for (const c of chosen) {
    for (const d of c.dependencies) {
      if (d.path !== undefined && workspace.has(d.name) && d.req === "*" && d.kind !== "dev") {
        throw new PublishTargetError(
          "publish-cargo-dependency-version",
          `${c.name} depends on ${d.name} by path with no version, and cargo publishes no crate whose dependency has none`,
          `Give the dependency a version beside its path, such as ${d.name} = { path = "...", version = "${byName.get(d.name)?.version ?? "x.y.z"}" }; release.version can stamp it with the label.`,
        );
      }
    }
  }
  const needs = new Map(chosen.map((c) => [c.name, new Set(c.dependencies.filter((d) => d.path !== undefined && names.has(d.name) && d.name !== c.name && !(d.kind === "dev" && d.req === "*")).map((d) => d.name))]));
  const out: CargoCrate[] = [];
  const left = new Set(names);
  while (left.size > 0) {
    const ready = [...left].filter((n) => [...needs.get(n)!].every((d) => !left.has(d))).sort();
    if (ready.length === 0) throw new PublishTargetError("publish-cargo-cycle", `the crates ${[...left].sort().join(", ")} depend on each other, so none can be published first`, "Break the cycle: a dev-dependency with no version is not part of the order.");
    for (const n of ready) {
      out.push(byName.get(n)!);
      left.delete(n);
    }
  }
  return out;
}

function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    child.on("error", reject);
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

/** The workspace's crates, from `cargo metadata --no-deps`. */
export async function cargoWorkspace(
  cargo: string,
  manifest: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  runner: (bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }> = run,
): Promise<CargoCrate[]> {
  const r = await runner(cargo, ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest], cwd, env).catch((err: unknown) => {
    throw new PublishTargetError("publish-cargo-missing", `cargo could not be run: ${err instanceof Error ? err.message : String(err)}`, "Install a Rust toolchain on the job's PATH, such as with rustup.");
  });
  if (r.code === 127) throw new PublishTargetError("publish-cargo-missing", `cargo could not be run: ${r.stderr.trim()}`, "Install a Rust toolchain on the job's PATH, such as with rustup.");
  if (r.code !== 0) throw new PublishTargetError("publish-cargo-metadata", `cargo metadata on ${manifest} exited ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
  const meta = JSON.parse(r.stdout) as { packages?: Array<{ name: string; version: string; publish: string[] | null; dependencies?: Array<{ name: string; req: string; kind: string | null; path?: string }> }> };
  return (meta.packages ?? []).map((p) => ({ name: p.name, version: p.version, publish: p.publish ?? null, dependencies: (p.dependencies ?? []).map((d) => ({ name: d.name, req: d.req, kind: d.kind ?? null, ...(d.path ? { path: d.path } : {}) })) }));
}

export function cargoTarget(decl: CargoPublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const cargo = deps.cargo ?? "cargo";
  const label = decl.registry ? `Cargo registry ${decl.registry}` : "crates.io";
  const index = (decl.index ?? CRATES_IO_INDEX).replace(/^sparse\+/, "").replace(/\/*$/, "/");
  const api = (decl.api ?? CRATES_IO_API).replace(/\/+$/, "");
  const tokenName = cargoTokenEnv(decl);
  const cargoVar = cargoRegistryTokenVar(decl.registry);

  const setup = async (ctx: PublishContext) => {
    if (ctx.requireSbom && decl.sbom !== false) {
      throw new PublishTargetError(
        "publish-sbom-missing",
        `${label} keeps no file beside a crate, so the crates this target publishes carry no SBOM`,
        "Attach the SBOM to the release elsewhere, such as with a forge target, and set sbom: false on this target.",
      );
    }
    const manifest = memberFile(ctx.cwd, decl.manifest ?? "Cargo.toml");
    const crates = cargoPublishOrder(await cargoWorkspace(cargo, manifest, ctx.cwd, ctx.env), decl);
    const auth = cargoAuth(decl, ctx.env);
    let token: string | null = null;
    if (auth === "token") {
      const cred = readCredential(ctx.env, [tokenName], ctx.redactor);
      if (!cred) {
        throw new PublishTargetError(
          "publish-credentials-missing",
          `the ${label} target reads its token from ${tokenName}, and it is not set${decl.registry ? "" : ", and this run has no OIDC ID token for trusted publishing"}`,
          decl.registry ? `Set ${tokenName} to a token of the registry.` : `Set ${tokenName} to a crates.io API token with the publish-update scope (publish-new for a new crate), or publish from a GitHub Actions job with id-token: write and a trusted publisher on each crate.`,
        );
      }
      token = cred.value;
    } else if (!hasIdToken(ctx.env, CRATES_IO_ID_TOKEN_ENV)) {
      throw new PublishTargetError(
        "publish-credentials-missing",
        `the crates.io target publishes with trusted publishing, and this run has no OIDC ID token: not a GitHub Actions job with id-token: write, and ${CRATES_IO_ID_TOKEN_ENV} is not set`,
        "In GitHub Actions, give the job permissions: id-token: write.",
      );
    }
    const items: PublishItem[] = crates.map((c) => ({ name: `${c.name}@${c.version}`, destination: decl.registry ? `${index}${sparseIndexPath(c.name)}` : `${CRATES_IO_API}/crates/${c.name}/${c.version}` }));
    return { manifest, crates, auth, token, items };
  };

  /** The checksum the index records for the crate's version, null when it has no such version. */
  const indexed = async (ctx: PublishContext, c: CargoCrate, token: string | null): Promise<string | null> => {
    const url = `${index}${sparseIndexPath(c.name)}`;
    const res = await fetchImpl(url, { method: "GET", headers: { "user-agent": "chant", ...(decl.registry && token ? { authorization: token } : {}) } });
    const text = await res.text().catch(() => "");
    if (res.status === 404 || res.status === 410) return null;
    if (res.status !== 200) throw new PublishTargetError("publish-cargo-failed", ctx.redactor.redact(`reading ${url} on ${label} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`));
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as { vers?: unknown; cksum?: unknown };
        if (v.vers === c.version) return typeof v.cksum === "string" ? v.cksum : "";
      } catch {
        // A line that is not JSON names no version.
      }
    }
    return null;
  };

  /** Trusted publishing: a crates.io token for this run, and how to revoke it. */
  const exchange = async (ctx: PublishContext): Promise<{ token: string; revoke: () => Promise<void> }> => {
    const jwt = await runIdToken(ctx, fetchImpl, CRATES_IO_AUDIENCE, CRATES_IO_ID_TOKEN_ENV, "publish-cargo-trusted-publishing");
    const url = `${api}/api/v1/trusted_publishing/tokens`;
    const res = await fetchImpl(url, { method: "POST", headers: { "user-agent": "chant", "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jwt }) });
    const text = await res.text().catch(() => "");
    let body: { token?: unknown; errors?: Array<{ detail?: unknown }> } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // Reported by its status.
    }
    if (res.status < 200 || res.status > 299 || typeof body.token !== "string" || !body.token) {
      const why = (body.errors ?? []).map((e) => (typeof e.detail === "string" ? e.detail : "")).filter(Boolean).join("; ");
      throw new PublishTargetError(
        "publish-cargo-trusted-publishing",
        ctx.redactor.redact(`crates.io gave no token for this run's OIDC ID token: it answered ${res.status}${why ? `: ${why}` : ""}`),
        "Add this repository and workflow as a trusted publisher in each crate's settings on crates.io. A crate's first version can't be published this way; publish it once with a token.",
      );
    }
    const token = body.token;
    ctx.redactor.add(token);
    return {
      token,
      revoke: async () => {
        const r = await fetchImpl(url, { method: "DELETE", headers: { "user-agent": "chant", authorization: `Bearer ${token}` } }).catch(() => null);
        if (r && r.status >= 300) ctx.log(`crates.io answered ${r.status} to revoking the trusted-publishing token; it expires on its own`);
      },
    };
  };

  const target: PublishTarget = {
    kind: "cargo",
    name: decl.crates ? `${label} ${decl.crates.join(", ")}` : `${label} ${decl.manifest ?? "Cargo.toml"}`,
    destination: label,
    credentialEnv: [tokenName, CRATES_IO_ID_TOKEN_ENV],
    key: publishTargetKey(decl),
    uploadsAtReveal: true,
    async plan(ctx) {
      return (await setup(ctx)).items;
    },
    async stage(ctx) {
      const { crates, auth, token, items } = await setup(ctx);
      if (auth === "trusted-publishing") {
        const t = await exchange(ctx);
        await t.revoke();
        ctx.log("crates.io takes this run as a trusted publisher; the reveal asks for a new token, since one lasts minutes");
      } else {
        ctx.log(`using the token from ${tokenName}; ${label} has no read-only check of a token, so whether it may publish shows at the reveal`);
      }
      const out: PublishItem[] = [];
      for (const [i, c] of crates.entries()) {
        const cksum = await indexed(ctx, c, token);
        out.push(cksum === null ? items[i]! : { ...items[i]!, present: true, ...(cksum ? { digest: `sha256:${cksum}` } : {}) });
      }
      const waiting = out.filter((i) => !i.present).map((i) => i.name);
      ctx.log(waiting.length === 0 ? `${label} already has every crate at its version` : `${waiting.join(", ")} ${waiting.length === 1 ? "is" : "are"} published at the reveal, in this order, since ${label} has no draft`);
      const staged: StagedTarget = { target: target.name, destination: target.destination, items: out, state: waiting.length === 0 ? { present: "true" } : {} };
      return staged;
    },
    async reveal(ctx, staged) {
      if (staged.state.present === "true") return { target: target.name, destination: target.destination, items: staged.items.map((i) => ({ ...i, present: true })) };
      const { manifest, crates, auth, token, items } = await setup(ctx);
      let publishToken = token;
      let revoke: (() => Promise<void>) | null = null;
      const done: string[] = [];
      const out: PublishItem[] = [];
      try {
        for (const [i, c] of crates.entries()) {
          // Read again before each crate: one an earlier reveal published is not published twice.
          const before = await indexed(ctx, c, publishToken);
          if (before !== null) {
            out.push({ ...items[i]!, present: true, ...(before ? { digest: `sha256:${before}` } : {}) });
            continue;
          }
          if (publishToken === null) {
            const t = await exchange(ctx);
            publishToken = t.token;
            revoke = t.revoke;
          }
          const args = ["publish", "-p", c.name, "--manifest-path", resolve(manifest), "--no-verify", "--allow-dirty", ...(decl.registry ? ["--registry", decl.registry] : [])];
          ctx.log(`running cargo ${args.join(" ")}`);
          const r = await run(cargo, args, ctx.cwd, { ...ctx.env, [cargoVar]: publishToken }).catch((err: unknown) => {
            throw new PublishTargetError("publish-cargo-missing", `cargo could not be run: ${err instanceof Error ? err.message : String(err)}`, "Install a Rust toolchain on the job's PATH.");
          });
          for (const l of `${r.stdout}\n${r.stderr}`.split("\n").filter((x) => x.trim())) ctx.log(`cargo: ${ctx.redactor.redact(l)}`);
          if (r.code !== 0) {
            const tail = ctx.redactor.redact(r.stderr.trim().split("\n").slice(-3).join(" "));
            throw new PublishTargetError(
              "publish-cargo-failed",
              `cargo publish of ${c.name}@${c.version} exited ${r.code}${tail ? `: ${tail}` : ""}${done.length ? `. Published before it: ${done.join(", ")}; the same publish run again publishes only the rest` : ""}`,
            );
          }
          done.push(`${c.name}@${c.version}`);
          const after = await indexed(ctx, c, publishToken).catch(() => null);
          out.push({ ...items[i]!, ...(after ? { digest: `sha256:${after}` } : {}) });
        }
      } finally {
        if (revoke) await revoke();
      }
      return { target: target.name, destination: target.destination, items: out };
    },
  };
  return target;
}
