/**
 * `chant release doctor` (#5161): before anything is cut, ask each target
 * `release.publish` declares whether a publish from this environment can
 * succeed, without changing anything on any registry.
 *
 * Each check ends in one of four states:
 *
 * - `ok`: the registry or forge said yes.
 * - `fail`: it said no, or a credential the publish needs is not here. In CI
 *   a missing credential fails; on a workstation it is a warning, since the
 *   release job's environment is not this one.
 * - `warn`: something the publish can live with, or evidence that points the
 *   wrong way without proving it, such as the workflow the last version was
 *   published from.
 * - `unknown`: what can't be observed from here. npm matches a trusted
 *   publisher against the workflow that asks, so only a run of the release
 *   workflow can test the record; whether a record allows `npm dist-tag`, and
 *   what a job token may do, are not shown to anyone. The doctor says so
 *   rather than guessing.
 *
 * The probes are reads, apart from two exchanges that hand back a short-lived
 * publishing token, which is masked and dropped: npm's OIDC exchange and Open
 * VSX's trusted-publishing exchange, the same requests a publish makes first.
 *
 * Under `release.green: "forge-checks"` (#5149) the cut asks the forge for the
 * commit's checks, so the doctor reads the checks of the checked-out commit
 * with the token the cut would use (`green-forge-checks`). Whether that
 * commit is green is the cut's question; the doctor only asks whether the
 * forge answers.
 *
 * When the publish signs with Sigstore (#5164, ./publish-signing.ts), the
 * doctor checks what signing needs from the job it runs in: the OIDC token
 * cosign signs with (`signing-oidc`) and cosign 3 (`signing-cosign`).
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createRedactor, readCredential, type Redactor } from "./publish-credentials";
import type {
  CargoPublishDeclaration,
  ForgePublishDeclaration,
  HomebrewPublishDeclaration,
  HelmPublishDeclaration,
  IndexPublishDeclaration,
  MarketplacePublishDeclaration,
  McpRegistryPublishDeclaration,
  NpmPublishDeclaration,
  OciPublishDeclaration,
  PublishDeclaration,
  PypiPublishDeclaration,
  TauriUpdaterPublishDeclaration,
} from "./publish-declaration";
import type { PublishFetch } from "./release-publish";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant with `chant release doctor`, which checks each `release.publish` target before a cut, and whose `chant release workflow` runs it in a dispatched release's cut job (`release.workflow.doctor`) (#5161). */
export const RELEASE_DOCTOR_FLOOR = NEXT_RELEASE;

export type DoctorStatus = "ok" | "warn" | "fail" | "unknown";

export interface DoctorCheck {
  /** What was checked, such as `npm-trusted-publisher`. */
  check: string;
  status: DoctorStatus;
  /** What the check found, or why it can't tell. */
  message: string;
  fix?: string;
}

export interface DoctorTarget {
  kind: string;
  /** For messages, such as `npm @acme/core` or `oci ghcr.io/acme/api`. */
  name: string;
  checks: DoctorCheck[];
}

/** Where the doctor runs, which decides what it can observe. */
export interface DoctorEnvironment {
  /** `github`, `gitlab`, another CI, or null on a workstation. */
  ci: "github" | "gitlab" | "other" | null;
  /** Whether the run can get an OIDC ID token. */
  oidc: boolean;
  /** The workflow file this run is, from the repository root, when the CI says (GitHub: `GITHUB_WORKFLOW_REF`). */
  workflow: string | null;
  /** `owner/name` of the repository, from the CI or the `origin` remote. */
  repository: string | null;
  /** The release workflow file, from the repository root: `release.workflow.file` or the forge's default. */
  releaseWorkflow: string | null;
}

export interface DoctorReport {
  environment: DoctorEnvironment;
  targets: DoctorTarget[];
  counts: Record<DoctorStatus, number>;
}

/** A command run for a check: npm or vsce. */
export type DoctorRun = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DoctorDeps {
  fetch?: PublishFetch;
  run?: DoctorRun;
  /** The npm executable. Default `npm`. */
  npm?: string;
  /** The vsce executable. Default `vsce`. */
  vsce?: string;
  /** What would sign with Sigstore (#5164). Default: cosign, as the publish runs it. */
  signer?: Pick<import("./publish-signing").Signer, "name" | "unavailable">;
  /** The cargo executable. Default `cargo`. */
  cargo?: string;
}

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

function defaultRun(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    child.on("error", (err) => done({ code: 127, stdout, stderr: err.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

/** The CI this process runs in, and whether it can get an OIDC token, from its environment. */
export function doctorEnvironment(env: NodeJS.ProcessEnv, req: { cwd: string; releaseWorkflow: string | null }): DoctorEnvironment {
  const ci = env.GITHUB_ACTIONS === "true" ? "github" : env.GITLAB_CI === "true" ? "gitlab" : env.CI ? "other" : null;
  const oidc = ci === "github" ? Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) : ci === "gitlab" ? Boolean(env.NPM_ID_TOKEN || env.SIGSTORE_ID_TOKEN || env.OVSX_ID_TOKEN) : Boolean(env.OVSX_ID_TOKEN);
  // GITHUB_WORKFLOW_REF is `owner/name/.github/workflows/release.yml@refs/heads/main`.
  const ref = env.GITHUB_WORKFLOW_REF ?? "";
  const repository = env.GITHUB_REPOSITORY ?? (ci === "gitlab" ? (env.CI_PROJECT_PATH ?? null) : originRepository(req.cwd));
  const workflow = ci === "github" && repository && ref.startsWith(`${repository}/`) ? ref.slice(repository.length + 1).replace(/@.*$/, "") : null;
  return { ci, oidc, workflow, repository, releaseWorkflow: req.releaseWorkflow };
}

/** `owner/name` of the `origin` remote, or null. */
function originRepository(cwd: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

interface Ctx {
  cwd: string;
  env: NodeJS.ProcessEnv;
  environment: DoctorEnvironment;
  redactor: Redactor;
  fetch: PublishFetch;
  run: DoctorRun;
  npm: string;
  vsce: string;
  cargo: string;
}

/** Check every declared target. Nothing is published, tagged or changed. */
export async function releaseDoctor(req: {
  cwd: string;
  publish: readonly PublishDeclaration[];
  env?: NodeJS.ProcessEnv;
  releaseWorkflow: string | null;
  /** The cut's green gate (#5149); `forge-checks` adds the check that the forge answers for the commit's checks. */
  green?: import("./release-green").ReleaseGreenSource;
  /** The commit whose checks are read under `forge-checks`. Default: HEAD of `cwd`. */
  commit?: string;
  /** `release.signing` (#5164), and the workspace's security groups, which decide whether the publish signs. */
  signing?: import("./publish-signing").SigningConfig;
  groups?: ReadonlySet<import("../workspace/security").SecurityGroup>;
  deps?: DoctorDeps;
}): Promise<DoctorReport> {
  const env = req.env ?? process.env;
  const deps = req.deps ?? {};
  const environment = doctorEnvironment(env, { cwd: req.cwd, releaseWorkflow: req.releaseWorkflow });
  const redactor = createRedactor(env);
  const ctx: Ctx = {
    cwd: req.cwd,
    env,
    environment,
    redactor,
    fetch: deps.fetch ?? (globalThis.fetch as unknown as PublishFetch),
    run: deps.run ?? defaultRun,
    npm: deps.npm ?? "npm",
    vsce: deps.vsce ?? "vsce",
    cargo: deps.cargo ?? "cargo",
  };
  const targets: DoctorTarget[] = [];
  for (const decl of req.publish) {
    try {
      targets.push(...(await checkTarget(decl, ctx)));
    } catch (err) {
      targets.push({ kind: decl.type, name: decl.type, checks: [{ check: `${decl.type}-check`, status: "unknown", message: `the check could not run: ${err instanceof Error ? err.message : String(err)}` }] });
    }
  }
  if (req.green === "forge-checks") targets.push(await checkForgeChecks(ctx, req.commit));
  const signing = await checkSigning(ctx, req.publish, req.signing, req.groups ?? new Set(), deps.signer);
  if (signing) targets.push(signing);
  for (const t of targets) for (const c of t.checks) c.message = redactor.redact(c.message);
  const counts: Record<DoctorStatus, number> = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const t of targets) for (const c of t.checks) counts[c.status]++;
  return { environment, targets, counts };
}

async function checkTarget(decl: PublishDeclaration, ctx: Ctx): Promise<DoctorTarget[]> {
  switch (decl.type) {
    case "npm":
      return checkNpm(decl, ctx);
    case "oci":
      return [await checkOci(decl, ctx)];
    case "forge":
      return [await checkForge(decl, ctx)];
    case "homebrew":
      return [await checkHomebrew(decl, ctx)];
    case "marketplace":
      return [await checkMarketplace(decl, ctx)];
    case "tauri-updater":
      return [await checkTauri(decl, ctx)];
    case "pypi":
      return [await checkPypi(decl, ctx)];
    case "cargo":
      return [await checkCargo(decl, ctx)];
    case "mcp-registry":
      return [await checkMcpRegistry(decl, ctx)];
    case "index":
      return [await checkIndex(decl, ctx)];
    case "helm":
      return checkHelm(decl, ctx);
  }
}

/**
 * `release.green: "forge-checks"`: the forge and token the cut would ask, and
 * whether that token reads the commit's checks and statuses.
 */
async function checkForgeChecks(ctx: Ctx, commit: string | undefined): Promise<DoctorTarget> {
  const checks: DoctorCheck[] = [];
  const t: DoctorTarget = { kind: "green", name: "release.green forge-checks", checks };
  const { forgeChecksReader, forgeChecksTarget, ForgeChecksUnavailableError } = await import("./release-green");
  let target: Awaited<ReturnType<typeof forgeChecksTarget>>;
  try {
    target = await forgeChecksTarget(ctx.cwd, ctx.env);
  } catch (err) {
    if (!(err instanceof ForgeChecksUnavailableError)) throw err;
    checks.push(missing(ctx, "green-forge-checks", err.message, err.fix ?? "Set release.green in chant.config.ts to \"chant\" or \"none\", or give the cut a forge token."));
    return t;
  }
  let sha = commit;
  if (!sha) {
    try {
      sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      checks.push({ check: "green-forge-checks", status: "unknown", message: `the token comes from ${target.tokenSource}, and there is no commit here to read the checks of` });
      return t;
    }
  }
  try {
    const verdict = await forgeChecksReader(target, ctx.env, ctx.fetch)(sha, null);
    const n = verdict.checks.length;
    checks.push({ check: "green-forge-checks", status: "ok", message: `the token from ${target.tokenSource} reads ${target.kind}'s checks on ${target.repo}: ${n} on ${sha.slice(0, 12)}${verdict.green ? ", all passed" : `; ${verdict.why}, which the cut will refuse unless it passes first`}` });
  } catch (err) {
    if (!(err instanceof ForgeChecksUnavailableError)) throw err;
    checks.push({ check: "green-forge-checks", status: "fail", message: `the cut can't read the commit's checks: ${err.message}`, fix: err.fix ?? `Give the token from ${target.tokenSource} read access to ${target.repo}'s checks and statuses.` });
  }
  return t;
}

/**
 * Sigstore signing (#5164), when `release.signing` or the `supply-chain`
 * group turns it on and an `oci` or `forge` target signs: whether this job
 * has the OIDC token the certificate is issued for, and cosign 3. Null when
 * the publish does not sign.
 */
async function checkSigning(
  ctx: Ctx,
  publish: readonly PublishDeclaration[],
  config: import("./publish-signing").SigningConfig | undefined,
  groups: ReadonlySet<import("../workspace/security").SecurityGroup>,
  injected: DoctorDeps["signer"],
): Promise<DoctorTarget | null> {
  const { resolveSigning, signingIdentity, cosignSigner } = await import("./publish-signing");
  const setting = resolveSigning(config, groups);
  if (!setting.on || !publish.some((d) => d.type === "oci" || d.type === "forge" || d.type === "pypi")) return null;
  const why = setting.from === "config" ? "release.signing" : "the supply-chain group";
  const checks: DoctorCheck[] = [];
  const id = signingIdentity(ctx.env);
  if ("reason" in id) {
    checks.push(
      missing(ctx, "signing-oidc", `${why} signs images and forge assets keylessly, and ${id.reason}`, "Publish from a CI job with an OIDC token (GitHub Actions: permissions: id-token: write; GitLab CI: SIGSTORE_ID_TOKEN under id_tokens with aud: sigstore), or set release.signing: false."),
    );
  } else {
    checks.push({ check: "signing-oidc", status: "ok", message: `the certificate will name ${id.identity.identity}, issuer ${id.identity.issuer}` });
  }
  const signer = injected ?? cosignSigner(ctx.env, ctx.redactor);
  const gone = signer.unavailable();
  checks.push(gone ? missing(ctx, "signing-cosign", gone, "Install cosign 3 in the job, as chant release workflow does, or point CHANT_COSIGN at it.") : { check: "signing-cosign", status: "ok", message: `${signer.name} signs` });
  return { kind: "signing", name: "Sigstore signing", checks };
}

/** A credential the publish needs and this environment lacks: a failure in CI, a warning on a workstation. */
function missing(ctx: Ctx, check: string, what: string, fix: string): DoctorCheck {
  return ctx.environment.ci
    ? { check, status: "fail", message: `${what}, so a publish from this job fails`, fix }
    : { check, status: "warn", message: `${what} in this shell; the release job needs it in its environment`, fix };
}

async function answer(ctx: Ctx, url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; text: string; json: unknown; header: (n: string) => string | null }> {
  const res = await ctx.fetch(url, { ...init, headers: { "user-agent": "chant", ...init.headers } });
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json, header: (n) => res.headers.get(n) };
}

const short = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}...` : text);

/** An OIDC ID token for `audience`: GitHub Actions' token service, else the variable named. Null when this run has none. */
async function idToken(ctx: Ctx, audience: string, variable: string): Promise<{ token: string } | { none: string }> {
  const direct = readCredential(ctx.env, [variable], ctx.redactor);
  if (direct) return { token: direct.value };
  if (!(ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL && ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)) return { none: ctx.environment.ci === "github" ? "this job has no id-token: write permission" : `this run has no OIDC token (no GitHub Actions id-token, and ${variable} is not set)` };
  ctx.redactor.add(ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  const url = new URL(ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", audience);
  const res = await answer(ctx, url.toString(), { method: "GET", headers: { authorization: `Bearer ${ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, accept: "application/json" } });
  const value = (res.json as { value?: unknown } | null)?.value;
  if (res.status !== 200 || typeof value !== "string" || !value) return { none: `GitHub Actions gave no ID token for ${audience} (it answered ${res.status})` };
  ctx.redactor.add(value);
  return { token: value };
}

/** The sentence for a check only a run of the release workflow can make, naming it when it is known. */
function onlyTheWorkflow(ctx: Ctx): string {
  return ctx.environment.releaseWorkflow ? `a run of ${ctx.environment.releaseWorkflow}` : "a run of the release workflow";
}

// npm

interface NpmPackageInfo {
  path: string;
  name: string | null;
  private: boolean;
  why?: string;
}

function npmPackageInfo(cwd: string, path: string): NpmPackageInfo {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  if (path.endsWith(".tgz")) {
    if (!existsSync(abs)) return { path, name: null, private: false, why: `${path} is not built yet, so its name can't be read` };
    try {
      const manifest = JSON.parse(execFileSync("tar", ["-xzOf", abs, "package/package.json"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })) as { name?: unknown; private?: unknown };
      return { path, name: typeof manifest.name === "string" ? manifest.name : null, private: manifest.private === true };
    } catch {
      return { path, name: null, private: false, why: `${path} holds no package/package.json chant can read` };
    }
  }
  const file = join(abs, "package.json");
  if (!existsSync(file)) return { path, name: null, private: false, why: `${path} has no package.json` };
  try {
    const manifest = JSON.parse(readFileSync(file, "utf-8")) as { name?: unknown; private?: unknown };
    return { path, name: typeof manifest.name === "string" ? manifest.name : null, private: manifest.private === true, ...(typeof manifest.name === "string" ? {} : { why: `${path}/package.json names no package` }) };
  } catch (err) {
    return { path, name: null, private: false, why: `${path}/package.json does not parse: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The registry the npm target publishes to: the declared one, else npm's own config, else npmjs. */
async function npmRegistry(decl: NpmPublishDeclaration, ctx: Ctx): Promise<string> {
  if (decl.registry) return decl.registry.replace(/\/+$/, "");
  const r = await ctx.run(ctx.npm, ["config", "get", "registry"], { cwd: ctx.cwd, env: ctx.env }).catch(() => null);
  const out = r && r.code === 0 ? r.stdout.trim() : "";
  return (/^https?:\/\//.test(out) ? out : DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
}

/** The repository and workflow file a version's SLSA provenance names, when npm has one from GitHub Actions. */
async function provenanceWorkflow(ctx: Ctx, url: string): Promise<{ repository: string; path: string } | null> {
  const res = await answer(ctx, url, { method: "GET", headers: { accept: "application/json" } });
  if (res.status !== 200) return null;
  const attestations = (res.json as { attestations?: Array<{ predicateType?: unknown; bundle?: { dsseEnvelope?: { payload?: unknown } } }> } | null)?.attestations ?? [];
  for (const a of attestations) {
    const payload = a.bundle?.dsseEnvelope?.payload;
    if (typeof payload !== "string" || !String(a.predicateType ?? "").startsWith("https://slsa.dev/provenance/")) continue;
    try {
      const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf-8")) as { predicate?: { buildDefinition?: { externalParameters?: { workflow?: { repository?: unknown; path?: unknown } } } } };
      const w = statement.predicate?.buildDefinition?.externalParameters?.workflow;
      if (typeof w?.repository === "string" && typeof w.path === "string") return { repository: w.repository.replace(/^https:\/\/github\.com\//, ""), path: w.path };
    } catch {
      // A statement chant can't read is no evidence.
    }
  }
  return null;
}

async function checkNpm(decl: NpmPublishDeclaration, ctx: Ctx): Promise<DoctorTarget[]> {
  const registry = await npmRegistry(decl, ctx);
  const host = new URL(registry).host;
  const npmjs = host === "registry.npmjs.org";
  const run = (args: string[]) => ctx.run(ctx.npm, [...args, "--registry", registry], { cwd: ctx.cwd, env: ctx.env }).catch((err: unknown) => ({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
  // npm's own credentials, the same for every package: a token in its config.
  const whoami = await run(["whoami"]);
  const user = whoami.code === 0 ? whoami.stdout.trim() : null;
  const out: DoctorTarget[] = [];
  for (const path of decl.packages) {
    const info = npmPackageInfo(ctx.cwd, path);
    const checks: DoctorCheck[] = [];
    const t: DoctorTarget = { kind: "npm", name: `npm ${info.name ?? path}`, checks };
    out.push(t);
    if (!info.name) {
      checks.push({ check: "npm-package", status: path.endsWith(".tgz") ? "unknown" : "fail", message: info.why ?? `${path} names no package` });
      continue;
    }
    if (info.private) {
      checks.push({ check: "npm-package", status: "fail", message: `${info.name} is private: true in its package.json, and npm refuses to publish it`, fix: "Remove private: true, or take the package out of the npm target." });
      continue;
    }
    const name = info.name;
    const packument = await answer(ctx, `${registry}/${name.replace("/", "%2f")}`, { method: "GET", headers: { accept: "application/json" } });
    const doc = packument.json as { "dist-tags"?: Record<string, string>; versions?: Record<string, { _npmUser?: { trustedPublisher?: unknown }; dist?: { attestations?: { url?: unknown } } }> } | null;
    const exists = packument.status === 200 && doc !== null;
    if (packument.status === 404) {
      checks.push({
        check: "npm-registry",
        status: "fail",
        message: `${name} is not on ${registry} yet (publish-npm-never-published, which refuses the cut). npm makes its first version latest as soon as it stages, and trusted publishing can't publish it, since a trusted publisher is set on a package that exists${user ? `; npm's config here signs in as ${user}, which can publish it by hand` : ""}`,
        fix: `Publish one placeholder version by hand (npm login, then npm publish), then add the trusted publisher on ${npmjs ? "npmjs.com under the package's Settings" : "the registry"}.`,
      });
    } else if (!exists) {
      checks.push({ check: "npm-registry", status: "unknown", message: `${registry} answered ${packument.status} for ${name}, so whether it exists can't be told${packument.text ? `: ${short(packument.text)}` : ""}` });
    } else {
      const latest = doc["dist-tags"]?.latest ?? null;
      checks.push({ check: "npm-registry", status: "ok", message: `${name} is on ${registry}${latest ? `, latest ${latest}` : ""}` });
      // Evidence from outside: how the latest version was published. Not the record itself, which only the package's owners can read.
      const version = latest ? doc.versions?.[latest] : undefined;
      if (version) {
        const trusted = version._npmUser?.trustedPublisher !== undefined;
        const url = typeof version.dist?.attestations?.url === "string" ? version.dist.attestations.url : null;
        const from = url ? await provenanceWorkflow(ctx, url).catch(() => null) : null;
        const expected = ctx.environment.releaseWorkflow;
        const repo = ctx.environment.repository;
        if (from) {
          const sameRepo = repo === null || from.repository.toLowerCase() === repo.toLowerCase();
          const sameFile = expected === null || from.path === expected;
          checks.push({
            check: "npm-last-publisher",
            status: sameRepo && sameFile ? "ok" : "warn",
            message: `${name}@${latest} was published ${trusted ? "by trusted publishing " : ""}from ${from.repository}, ${from.path}, by its provenance${sameRepo && sameFile ? "" : `, and this release publishes from ${repo ?? "this repository"}, ${expected ?? "its release workflow"}`}. This is the last publish, not the trusted-publisher record, which npm shows only to the package's owners`,
            ...(sameRepo && sameFile ? {} : { fix: `On ${npmjs ? "npmjs.com, the package's Settings, Trusted Publisher" : "the registry"}, name ${repo ?? "this repository"} and the workflow file ${expected ? expected.split("/").pop() : "of the release"}.` }),
          });
        } else {
          checks.push({ check: "npm-last-publisher", status: "unknown", message: `${name}@${latest} carries no GitHub Actions provenance, so where it was published from can't be read${trusted ? "; it was published by trusted publishing" : ""}` });
        }
      }
    }

    // The trusted-publisher record: only a run of the workflow it names can test it.
    const env = ctx.environment;
    if (!env.ci) {
      checks.push({ check: "npm-trusted-publisher", status: "unknown", message: `whether ${name}'s trusted publisher names this workflow can only be tested by ${onlyTheWorkflow(ctx)}: npm matches the record against the workflow whose OIDC token asks, and a workstation has none` });
    } else if (env.ci === "github" && env.workflow && env.releaseWorkflow && env.workflow !== env.releaseWorkflow) {
      checks.push({ check: "npm-trusted-publisher", status: "unknown", message: `this run is ${env.workflow}, and npm matches the trusted publisher against the workflow file that asks, so an exchange here says nothing about ${env.releaseWorkflow}` });
    } else if (exists) {
      const id = await idToken(ctx, `npm:${host}`, "NPM_ID_TOKEN");
      if ("none" in id) {
        checks.push(user ? { check: "npm-trusted-publisher", status: "unknown", message: `no trusted-publisher exchange: ${id.none}. npm's config signs in as ${user}, which the publish uses instead` } : { check: "npm-trusted-publisher", status: "fail", message: `${id.none}, and npm's config has no token, so nothing here can publish ${name}`, fix: "Give the job permissions: id-token: write (GitLab: an NPM_ID_TOKEN under id_tokens), or a token in the npm config it reads." });
      } else {
        const ex = await answer(ctx, `${registry}/-/npm/v1/oidc/token/exchange/package/${name.replace("/", "%2f")}`, { method: "POST", headers: { authorization: `Bearer ${id.token}` } });
        const token = (ex.json as { token?: unknown } | null)?.token;
        if (typeof token === "string") ctx.redactor.add(token);
        const reason = (ex.json as { message?: unknown; error?: unknown } | null)?.message ?? (ex.json as { error?: unknown } | null)?.error ?? short(ex.text);
        if (ex.status >= 200 && ex.status < 300) checks.push({ check: "npm-trusted-publisher", status: "ok", message: `npm exchanged this run's OIDC token for a publishing token for ${name}: its trusted publisher names this workflow` });
        else if (ex.status >= 400 && ex.status < 500)
          checks.push({
            check: "npm-trusted-publisher",
            status: user ? "warn" : "fail",
            message: `npm refused this run's OIDC token for ${name} (${ex.status}: ${String(reason)})${user ? `; the publish falls back to npm's config, signed in as ${user}` : ""}`,
            fix: `On ${npmjs ? "npmjs.com, the package's Settings, Trusted Publisher" : "the registry"}, name ${env.repository ?? "this repository"} and the workflow file ${env.workflow ?? env.releaseWorkflow ?? "of this run"}, with no environment unless the job names one.`,
          });
        else checks.push({ check: "npm-trusted-publisher", status: "fail", message: `${registry} gave no usable answer to the OIDC exchange for ${name} (${ex.status}), so the record could not be checked`, fix: "Run the doctor again once the registry answers." });
      }
    }

    // Credentials in npm's config, and whether they may write the package.
    if (user && exists) {
      const access = await run(["access", "list", "collaborators", name, "--json"]);
      let rights: string | undefined;
      try {
        rights = (JSON.parse(access.stdout) as Record<string, string>)[user];
      } catch {
        rights = undefined;
      }
      checks.push(
        rights === "read-write"
          ? { check: "npm-token", status: "ok", message: `npm's config signs in as ${user}, who may write ${name}` }
          : rights
            ? { check: "npm-token", status: "fail", message: `npm's config signs in as ${user}, who may only ${rights} ${name}`, fix: `Make ${user} a maintainer of ${name}, or publish with trusted publishing.` }
            : { check: "npm-token", status: "unknown", message: `npm's config signs in as ${user}; ${registry} did not say what ${user} may do to ${name}, and a granular token's own scope is not shown` },
      );
    } else if (!user && !env.oidc) {
      checks.push(missing(ctx, "npm-token", "npm's config has no token and the run has no OIDC token", "npm login on a workstation; in CI, permissions: id-token: write for trusted publishing, or a token in the npm config the job reads."));
    }

    // The reveal moves a dist-tag, unless the target publishes straight to latest.
    if (decl.stage !== false && exists) {
      const viaToken = checks.some((c) => c.check === "npm-token" && c.status === "ok");
      checks.push(
        viaToken
          ? { check: "npm-dist-tag", status: "ok", message: `the reveal moves latest with npm dist-tag add, and ${user} may write ${name}` }
          : {
              check: "npm-dist-tag",
              status: "unknown",
              message: `the reveal moves latest with npm dist-tag add; over trusted publishing that needs "Allow npm dist-tag" on ${name}'s record, which npm does not show, so the reveal is the first thing to try it`,
              fix: "When the record does not allow it, declare stage: false on the npm target to publish straight to latest.",
            },
      );
    }
  }
  return out;
}

// OCI

/** The scopes a registry token grants, when the token is a JWT with an `access` claim, as Docker Hub's is. */
function jwtAccess(token: string, name: string): string[] | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")) as { access?: Array<{ type?: string; name?: string; actions?: string[] }> };
    if (!Array.isArray(claims.access)) return null;
    return claims.access.filter((a) => a.type === "repository" && a.name === name).flatMap((a) => a.actions ?? []);
  } catch {
    return null;
  }
}

async function checkOci(decl: OciPublishDeclaration, ctx: Ctx): Promise<DoctorTarget> {
  const { parseRepository, ociCredential } = await import("./publish-oci");
  const repo = parseRepository(decl.repository);
  const checks: DoctorCheck[] = [];
  const t: DoctorTarget = { kind: "oci", name: `oci ${decl.repository}`, checks };
  const cred = ociCredential(decl, repo, { env: ctx.env, redactor: ctx.redactor });
  const local = /^http:/.test(repo.base);
  const vars = `${decl.usernameEnv ?? "OCI_USERNAME"} and ${decl.passwordEnv ?? "OCI_PASSWORD"}`;
  if (cred) checks.push({ check: "oci-credentials", status: "ok", message: `credentials for ${repo.host} come from ${cred.password.from}` });
  else if (local) checks.push({ check: "oci-credentials", status: "warn", message: `no credentials for ${repo.host}: neither ${vars} nor a docker config entry, so the push is anonymous` });
  else checks.push(missing(ctx, "oci-credentials", `no credentials for ${repo.host}: neither ${vars} nor a docker config entry`, `Set ${vars}, or docker login ${repo.host}.`));
  const basic = cred ? `Basic ${Buffer.from(`${cred.username}:${cred.password.value}`).toString("base64")}` : null;
  if (basic) ctx.redactor.add(basic.slice(6));
  const ping = await answer(ctx, `${repo.base}/v2/`, { method: "GET", headers: {} });
  const challenge = ping.header("www-authenticate") ?? "";
  if (ping.status === 200) {
    checks.push({ check: "oci-push", status: "unknown", message: `${repo.base} asks for no credentials, so whether it takes a push shows only at the push` });
  } else if (ping.status === 401 && /^basic/i.test(challenge)) {
    if (!basic) return t;
    const again = await answer(ctx, `${repo.base}/v2/`, { method: "GET", headers: { authorization: basic } });
    checks.push(
      again.status === 200
        ? { check: "oci-push", status: "unknown", message: `${repo.base} takes the credentials; a Basic registry does not say whether they may push to ${repo.name} before a push` }
        : { check: "oci-push", status: "fail", message: `${repo.base} refused the credentials (${again.status})`, fix: `Check ${vars}.` },
    );
  } else if (ping.status === 401 && /^bearer/i.test(challenge)) {
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!.toLowerCase(), m[2]!]));
    if (!params.realm) {
      checks.push({ check: "oci-push", status: "unknown", message: `${repo.base} sent a Bearer challenge with no realm` });
      return t;
    }
    const u = new URL(params.realm);
    if (params.service) u.searchParams.set("service", params.service);
    u.searchParams.set("scope", `repository:${repo.name}:pull,push`);
    const res = await answer(ctx, u.toString(), { method: "GET", headers: basic ? { authorization: basic } : {} });
    const token = (res.json as { token?: unknown; access_token?: unknown } | null)?.token ?? (res.json as { access_token?: unknown } | null)?.access_token;
    if (typeof token === "string") ctx.redactor.add(token);
    if (res.status !== 200 || typeof token !== "string") {
      checks.push({ check: "oci-push", status: basic ? "fail" : "unknown", message: `the token service of ${repo.host} answered ${res.status}${basic ? " to these credentials" : " with no credentials"}${res.text ? `: ${short(res.text)}` : ""}`, ...(basic ? { fix: `Check ${vars}.` } : {}) });
    } else {
      const actions = jwtAccess(token, repo.name);
      checks.push(
        actions === null
          ? { check: "oci-push", status: "unknown", message: `${repo.host} handed out a token for ${repo.name}, and its token does not say what it grants; whether it may push shows only at the push${repo.host === "ghcr.io" ? " (with the job's token, the workflow needs packages: write)" : ""}` }
          : actions.includes("push")
            ? { check: "oci-push", status: "ok", message: `${repo.host} grants push on ${repo.name}` }
            : { check: "oci-push", status: "fail", message: `${repo.host} grants ${actions.length > 0 ? actions.join(", ") : "nothing"} on ${repo.name}, not push`, fix: `Give the credentials write access to ${repo.name}.` },
      );
    }
  } else {
    checks.push({ check: "oci-push", status: "unknown", message: `${repo.base}/v2/ answered ${ping.status}, which says nothing about a push` });
  }
  return t;
}

// Forges

/** What a token may do on a GitHub or Forgejo repository, from `GET /repos/{repo}`. */
async function repoAccess(ctx: Ctx, req: { forge: "github" | "forgejo"; api: string; repo: string; token: string; check: string; tokenFrom: string }): Promise<DoctorCheck> {
  const headers = req.forge === "github" ? { authorization: `Bearer ${req.token}`, accept: "application/vnd.github+json" } : { authorization: `token ${req.token}`, accept: "application/json" };
  const res = await answer(ctx, `${req.api}/repos/${req.repo}`, { method: "GET", headers });
  if (res.status === 401) return { check: req.check, status: "fail", message: `${req.api} refused the token in ${req.tokenFrom} (401)`, fix: `Check ${req.tokenFrom}.` };
  if (res.status === 404 || res.status === 403) return { check: req.check, status: "fail", message: `the token in ${req.tokenFrom} can't see ${req.repo} on ${req.api} (${res.status})`, fix: `Give the token access to ${req.repo}, or fix repo in the target.` };
  if (res.status !== 200) return { check: req.check, status: "unknown", message: `${req.api}/repos/${req.repo} answered ${res.status}` };
  const push = (res.json as { permissions?: { push?: unknown } } | null)?.permissions?.push;
  if (push === true) return { check: req.check, status: "ok", message: `the token in ${req.tokenFrom} may write ${req.repo}` };
  if (push === false) return { check: req.check, status: "fail", message: `the token in ${req.tokenFrom} may read ${req.repo} and not write it`, fix: `Give the token write access to ${req.repo}${req.forge === "github" ? " (contents: write)" : ""}.` };
  const scopes = res.header("x-oauth-scopes");
  if (scopes !== null) {
    const list = scopes.split(",").map((s) => s.trim());
    return list.includes("repo") || list.includes("public_repo")
      ? { check: req.check, status: "ok", message: `the token in ${req.tokenFrom} has the ${list.includes("repo") ? "repo" : "public_repo"} scope and sees ${req.repo}` }
      : { check: req.check, status: "fail", message: `the token in ${req.tokenFrom} sees ${req.repo} with scopes ${scopes || "none"}, and writing a release needs repo or public_repo`, fix: "Give the token the repo scope." };
  }
  return {
    check: req.check,
    status: "unknown",
    message: `the token in ${req.tokenFrom} sees ${req.repo}; ${req.api} does not say what this kind of token may write${ctx.environment.ci === "github" && req.tokenFrom === "GITHUB_TOKEN" ? ", and a job token gets contents: write from the workflow's permissions" : ""}`,
  };
}

async function checkForge(decl: ForgePublishDeclaration, ctx: Ctx): Promise<DoctorTarget> {
  const { forgeApi, forgeTokenEnv } = await import("./publish-forge");
  const checks: DoctorCheck[] = [];
  const t: DoctorTarget = { kind: "forge", name: `forge ${decl.forge} ${decl.repo}`, checks };
  const api = forgeApi(decl, ctx.env);
  if (!api) {
    checks.push({ check: "forge-api", status: "fail", message: "a Forgejo target has no API root: api is not declared and GITHUB_API_URL is not set", fix: "Declare api on the target, such as https://forgejo.example.com/api/v1." });
    return t;
  }
  const names = forgeTokenEnv(decl);
  const token = readCredential(ctx.env, names, ctx.redactor);
  if (!token) {
    checks.push(missing(ctx, "forge-token", `none of ${names.join(", ")} is set`, `Set ${names[0]}${decl.forge === "github" ? "; in GitHub Actions, GITHUB_TOKEN: ${{ github.token }} in the job's env" : ""}.`));
    return t;
  }
  checks.push({ check: "forge-token", status: "ok", message: `the token comes from ${token.from}` });
  if (decl.forge === "gitlab") {
    checks.push(await gitlabAccess(ctx, api, decl.repo, token));
    return t;
  }
  checks.push(await repoAccess(ctx, { forge: decl.forge, api, repo: decl.repo, token: token.value, check: "forge-access", tokenFrom: token.from }));
  return t;
}

/** What a GitLab token may do on a project: its scopes, and its access level there. A job token is not introspectable. */
async function gitlabAccess(ctx: Ctx, api: string, project: string, token: { value: string; from: string }): Promise<DoctorCheck> {
  if (token.from === "CI_JOB_TOKEN") return { check: "forge-access", status: "unknown", message: "the token is the job's CI_JOB_TOKEN, whose rights are the job's and can't be read; GitLab lets it create releases and upload to the generic package registry of its own project" };
  const headers = { "private-token": token.value };
  const self = await answer(ctx, `${api}/personal_access_tokens/self`, { method: "GET", headers });
  if (self.status === 401) return { check: "forge-access", status: "fail", message: `${api} refused the token in ${token.from} (401)`, fix: `Check ${token.from}; it may have expired.` };
  const scopes = (self.json as { scopes?: unknown } | null)?.scopes;
  if (self.status === 200 && Array.isArray(scopes) && !scopes.includes("api")) {
    return { check: "forge-access", status: "fail", message: `the token in ${token.from} has scopes ${scopes.join(", ") || "none"}, and releases and the package registry need api`, fix: "Give the token the api scope." };
  }
  const proj = await answer(ctx, `${api}/projects/${encodeURIComponent(project)}`, { method: "GET", headers });
  if (proj.status === 404 || proj.status === 403) return { check: "forge-access", status: "fail", message: `the token in ${token.from} can't see project ${project} (${proj.status})`, fix: `Give the token's user access to ${project}, or fix repo in the target.` };
  const perms = (proj.json as { permissions?: { project_access?: { access_level?: number } | null; group_access?: { access_level?: number } | null } } | null)?.permissions;
  const level = Math.max(perms?.project_access?.access_level ?? 0, perms?.group_access?.access_level ?? 0);
  if (proj.status === 200 && perms && level >= 30) return { check: "forge-access", status: "ok", message: `the token in ${token.from}${Array.isArray(scopes) ? " has the api scope and" : ""} is Developer or above on ${project}` };
  if (proj.status === 200 && perms && level > 0) return { check: "forge-access", status: "fail", message: `the token in ${token.from} has access level ${level} on ${project}, and creating a release needs Developer (30)`, fix: `Raise the token's role on ${project} to Developer.` };
  return { check: "forge-access", status: "unknown", message: `${api} did not say what the token in ${token.from} may do on ${project} (${proj.status})` };
}

async function checkHomebrew(decl: HomebrewPublishDeclaration, ctx: Ctx): Promise<DoctorTarget> {
  const { HOMEBREW_TOKEN_ENV } = await import("./publish-homebrew");
  const { githubApi } = await import("./publish-github");
  const checks: DoctorCheck[] = [];
  const t: DoctorTarget = { kind: "homebrew", name: `homebrew ${decl.tap}`, checks };
  if (decl.sshKeyEnv) {
    const key = readCredential(ctx.env, [decl.sshKeyEnv], ctx.redactor);
    if (!key) checks.push(missing(ctx, "homebrew-credentials", `${decl.sshKeyEnv} is not set`, `Set ${decl.sshKeyEnv} to a deploy key of ${decl.tap} with write access.`));
    else checks.push({ check: "homebrew-access", status: "unknown", message: `the SSH key in ${decl.sshKeyEnv} is set; whether it is a deploy key with write access shows only when it pushes` });
    return t;
  }
  const name = decl.tokenEnv ?? HOMEBREW_TOKEN_ENV;
  const token = readCredential(ctx.env, [name], ctx.redactor);
  if (!token) {
    checks.push(missing(ctx, "homebrew-credentials", `${name} is not set`, `Set ${name} to a token that may push to ${decl.tap}.`));
    return t;
  }
  checks.push(await repoAccess(ctx, { forge: "github", api: githubApi(decl.api, ctx.env), repo: decl.tap, token: token.value, check: "homebrew-access", tokenFrom: token.from }));
  return t;
}

/**
 * An index target (#5158): the token is set, and may do what the target's
 * mode needs. `commit`: write the repository. `pull-request`: read the
 * index, push a branch to the fork (or make the fork), and open a pull
 * request, read from the fork's `permissions.push` and a classic token's
 * scopes. A fine-grained or app token's rights on a repository its owner
 * does not own are not shown.
 */
/**
 * A helm target (#5233): the registry's credentials as the oci target's
 * checks read them, for the repository the charts go under, and the token
 * that pushes the index and whether it sees the repository.
 */
async function checkHelm(decl: HelmPublishDeclaration, ctx: Ctx): Promise<DoctorTarget[]> {
  const out: DoctorTarget[] = [];
  if (decl.oci) {
    const oci = await checkOci({ type: "oci", image: "", repository: decl.oci.repository, ...(decl.oci.usernameEnv ? { usernameEnv: decl.oci.usernameEnv } : {}), ...(decl.oci.passwordEnv ? { passwordEnv: decl.oci.passwordEnv } : {}) }, ctx);
    out.push({ ...oci, kind: "helm", name: `helm oci ${decl.oci.repository}` });
  }
  if (decl.index) {
    const checks: DoctorCheck[] = [];
    const tokenEnv = decl.index.tokenEnv ?? "GITHUB_TOKEN";
    const branch = decl.index.branch ?? "gh-pages";
    out.push({ kind: "helm", name: `helm index ${decl.index.repo}@${branch}`, checks });
    const token = readCredential(ctx.env, [tokenEnv], ctx.redactor);
    if (!token) checks.push(missing(ctx, "helm-index-credentials", `${tokenEnv} is not set`, `Set ${tokenEnv} to a token that may push to ${branch} of ${decl.index.repo}.`));
    else {
      const { githubApi } = await import("./publish-github");
      checks.push(await repoAccess(ctx, { forge: "github", api: githubApi(decl.index.api, ctx.env), repo: decl.index.repo, token: token.value, check: "helm-index-access", tokenFrom: token.from }));
    }
  }
  return out;
}

async function checkIndex(decl: IndexPublishDeclaration, ctx: Ctx): Promise<DoctorTarget> {
  const { indexSettings } = await import("./publish-index");
  const { githubApi } = await import("./publish-github");
  const checks: DoctorCheck[] = [];
  let s: ReturnType<typeof indexSettings>;
  try {
    s = indexSettings(decl);
  } catch (err) {
    const e = err as { message?: string; fix?: string };
    return { kind: "index", name: `index ${decl.name}`, checks: [{ check: "index-config", status: "fail", message: e.message ?? String(err), ...(e.fix ? { fix: e.fix } : {}) }] };
  }
  const t: DoctorTarget = { kind: "index", name: `index ${s.name} in ${s.repo}${s.mode === "pull-request" ? " (pull request)" : ""}`, checks };
  if (s.sshKeyEnv) {
    const key = readCredential(ctx.env, [s.sshKeyEnv], ctx.redactor);
    if (!key) checks.push(missing(ctx, "index-credentials", `${s.sshKeyEnv} is not set`, `Set ${s.sshKeyEnv} to a deploy key of ${s.repo} with write access.`));
    else checks.push({ check: "index-access", status: "unknown", message: `the SSH key in ${s.sshKeyEnv} is set; whether it is a deploy key with write access shows only when it pushes` });
    return t;
  }
  const token = readCredential(ctx.env, [s.tokenEnv], ctx.redactor);
  if (!token) {
    checks.push(
      missing(
        ctx,
        "index-credentials",
        `${s.tokenEnv} is not set`,
        s.mode === "commit" ? `Set ${s.tokenEnv} to a token that may push to ${s.repo}.` : `Set ${s.tokenEnv} to a classic token with public_repo, which may fork ${s.repo}, push to the fork and open a pull request.`,
      ),
    );
    return t;
  }
  const api = githubApi(decl.api, ctx.env);
  if (s.mode === "commit") {
    checks.push(await repoAccess(ctx, { forge: "github", api, repo: s.repo, token: token.value, check: "index-access", tokenFrom: token.from }));
    return t;
  }
  const headers = { authorization: `Bearer ${token.value}`, accept: "application/vnd.github+json" };
  const up = await answer(ctx, `${api}/repos/${s.repo}`, { method: "GET", headers });
  if (up.status === 401) {
    checks.push({ check: "index-upstream", status: "fail", message: `${api} refused the token in ${token.from} (401)`, fix: `Check ${token.from}; it may have expired.` });
    return t;
  }
  if (up.status !== 200) {
    checks.push({ check: "index-upstream", status: "fail", message: `the token in ${token.from} can't see ${s.repo} on ${api} (${up.status})`, fix: `Fix repo in the target, or give the token access to ${s.repo}.` });
    return t;
  }
  checks.push({ check: "index-upstream", status: "ok", message: `the token in ${token.from} sees ${s.repo}` });
  const scopes = up.header("x-oauth-scopes");
  const list = scopes === null ? null : scopes.split(",").map((x) => x.trim()).filter(Boolean);
  const classic = list !== null && (list.includes("repo") || list.includes("public_repo"));
  const fork = s.fork ?? null;
  if (fork !== null) {
    checks.push(await repoAccess(ctx, { forge: "github", api, repo: fork, token: token.value, check: "index-fork", tokenFrom: token.from }));
  } else {
    const me = await answer(ctx, `${api}/user`, { method: "GET", headers });
    const login = (me.json as { login?: unknown } | null)?.login;
    if (me.status !== 200 || typeof login !== "string") {
      checks.push({ check: "index-fork", status: "unknown", message: `${api}/user did not name the token's user (${me.status}), so its fork of ${s.repo} can't be found; the publish asks GitHub for it` });
    } else {
      const repoName = s.repo.split("/")[1]!;
      const theirs = await answer(ctx, `${api}/repos/${login}/${repoName}`, { method: "GET", headers });
      const body = theirs.json as { fork?: unknown; permissions?: { push?: unknown } } | null;
      if (theirs.status === 200 && body?.fork === true && body.permissions?.push !== false) {
        checks.push({ check: "index-fork", status: "ok", message: `${login}/${repoName} is ${login}'s fork of ${s.repo}, and the token may push its branch there` });
      } else if (theirs.status === 200 && body?.fork !== true) {
        checks.push({ check: "index-fork", status: "warn", message: `${login}/${repoName} is a repository of ${login} that is not a fork, so GitHub names the fork it makes otherwise`, fix: `Fork ${s.repo} and set fork in the target to it.` });
      } else if (classic) {
        checks.push({ check: "index-fork", status: "ok", message: `${login} has no fork of ${s.repo}; the publish makes one, which the token's ${list!.includes("repo") ? "repo" : "public_repo"} scope allows` });
      } else if (list !== null) {
        checks.push({ check: "index-fork", status: "fail", message: `${login} has no fork of ${s.repo}, and the token in ${token.from} has scopes ${scopes || "none"}, which can't make one`, fix: "Give the token the public_repo scope, or fork the index and set fork in the target." });
      } else {
        checks.push({ check: "index-fork", status: "unknown", message: `${login} has no fork of ${s.repo}; whether this kind of token may make one shows only when the publish asks` });
      }
    }
  }
  checks.push(
    classic
      ? { check: "index-pull-request", status: "ok", message: `the token in ${token.from} has the ${list!.includes("repo") ? "repo" : "public_repo"} scope, which may open a pull request on ${s.repo}` }
      : list !== null
        ? { check: "index-pull-request", status: "fail", message: `the token in ${token.from} has scopes ${scopes || "none"}, and opening a pull request on ${s.repo} needs public_repo or repo`, fix: "Give the token the public_repo scope." }
        : {
            check: "index-pull-request",
            status: "unknown",
            message: `GitHub does not say what this kind of token may do on ${s.repo}, which its owner may not own; opening the pull request shows whether it can`,
          },
  );
  return t;
}

async function checkTauri(decl: TauriUpdaterPublishDeclaration, ctx: Ctx): Promise<DoctorTarget> {
  const { githubApi } = await import("./publish-github");
  const checks: DoctorCheck[] = [];
  const t: DoctorTarget = { kind: "tauri-updater", name: `tauri-updater ${decl.repo}`, checks };
  const name = decl.tokenEnv ?? "GITHUB_TOKEN";
  const token = readCredential(ctx.env, [name], ctx.redactor);
  if (!token) {
    checks.push(missing(ctx, "tauri-token", `${name} is not set`, `Set ${name}.`));
    return t;
  }
  checks.push(await repoAccess(ctx, { forge: "github", api: githubApi(decl.api, ctx.env), repo: decl.repo, token: token.value, check: "tauri-access", tokenFrom: token.from }));
  return t;
}

// MCP Registry

/**
 * The `server.json` is read and its name checked against the namespace the
 * auth can claim, the registry is asked whether it serves and holds the
 * server, and under GitHub OIDC in CI the exchange for a registry token is
 * made, which proves the registry takes this run for the name's owner. The
 * version is not checked: the cut stamps the label into the file.
 */
async function checkMcpRegistry(decl: McpRegistryPublishDeclaration, ctx: Ctx): Promise<DoctorTarget> {
  const { MCP_REGISTRY, MCP_GITHUB_TOKEN_ENV, MCP_REGISTRY_TOKEN_ENV, mcpRegistryAudience } = await import("./publish-mcp-registry");
  const registry = (decl.registry ?? MCP_REGISTRY).replace(/\/+$/, "");
  const path = decl.server ?? "server.json";
  const checks: DoctorCheck[] = [];
  const t: DoctorTarget = { kind: "mcp-registry", name: `mcp-registry ${path}`, checks };
  const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
  if (!existsSync(abs)) {
    checks.push({ check: "mcp-registry-server", status: "fail", message: `${path} does not exist in ${ctx.cwd}`, fix: "Add the server.json, with the name and the packages it publishes." });
    return t;
  }
  let name: string;
  try {
    const m = JSON.parse(readFileSync(abs, "utf-8")) as { name?: unknown };
    if (typeof m.name !== "string" || !m.name) throw new Error("it has no name");
    name = m.name;
  } catch (err) {
    checks.push({ check: "mcp-registry-server", status: "fail", message: `${path} is not a server.json: ${err instanceof Error ? err.message : String(err)}`, fix: "Fix the file." });
    return t;
  }
  t.name = `mcp-registry ${name}`;
  const auth = decl.auth ?? "github-oidc";
  const owner = ctx.environment.repository?.split("/")[0]?.toLowerCase() ?? null;
  const namespace = /^io\.github\.([^/]+)\//i.exec(name)?.[1]?.toLowerCase() ?? null;
  if (auth === "github-oidc" && namespace === null) {
    checks.push({ check: "mcp-registry-namespace", status: "fail", message: `${name} is not under io.github.<owner>/, the only namespace a GitHub OIDC login can claim`, fix: `Name the server io.github.${owner ?? "<owner>"}/<name>, or publish with registry-token after a DNS or HTTP login.` });
  } else if (auth === "github-oidc" && owner !== null && namespace !== owner) {
    checks.push({ check: "mcp-registry-namespace", status: "fail", message: `${name} is under io.github.${namespace}/, and this repository's owner is ${owner}`, fix: `Name the server io.github.${owner}/<name>.` });
  } else {
    checks.push({ check: "mcp-registry-namespace", status: "ok", message: `${name} is a namespace the ${auth} login can claim` });
  }
  const held = await answer(ctx, `${registry}/v0.1/servers/${encodeURIComponent(name)}/versions`, { method: "GET", headers: {} });
  checks.push(
    held.status === 200
      ? { check: "mcp-registry-server-listed", status: "ok", message: `${name} is on ${registry}` }
      : held.status === 404
        ? { check: "mcp-registry-server-listed", status: "ok", message: `${name} is not on ${registry} yet; the first publish adds it` }
        : { check: "mcp-registry-server-listed", status: "unknown", message: `${registry} answered ${held.status} for ${name}'s versions` },
  );
  if (auth !== "github-oidc") {
    const names = [decl.tokenEnv ?? (auth === "github-token" ? MCP_GITHUB_TOKEN_ENV : MCP_REGISTRY_TOKEN_ENV)];
    const token = readCredential(ctx.env, names, ctx.redactor);
    if (!token) {
      checks.push(missing(ctx, "mcp-registry-token", `${names[0]} is not set`, `Set ${names[0]}.`));
    } else if (auth === "github-token") {
      const ex = await answer(ctx, `${registry}/v0.1/auth/github-at`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ github_token: token.value }) });
      const value = (ex.json as { registry_token?: unknown } | null)?.registry_token;
      if (typeof value === "string") ctx.redactor.add(value);
      checks.push(ex.status === 200 && typeof value === "string" ? { check: "mcp-registry-auth", status: "ok", message: `the registry takes the token from ${token.from}` } : { check: "mcp-registry-auth", status: "fail", message: `the registry gave no token for the one in ${token.from} (${ex.status}${ex.text ? `: ${short(ex.text)}` : ""})`, fix: "Check the GitHub token, and that its owner may publish the server's namespace." });
    } else {
      checks.push({ check: "mcp-registry-auth", status: "unknown", message: `the token in ${token.from} is set; a registry token is checked only when it publishes` });
    }
    return t;
  }
  if (!ctx.environment.ci) {
    checks.push({ check: "mcp-registry-auth", status: "unknown", message: `whether the registry takes this workflow as the owner of ${name} can only be tested by ${onlyTheWorkflow(ctx)}, with its OIDC token` });
    return t;
  }
  const audience = mcpRegistryAudience(registry);
  // The target reads only GitHub Actions' token service, so no variable stands in for it.
  const tok = await idToken(ctx, audience, "");
  if ("none" in tok) {
    checks.push({ check: "mcp-registry-auth", status: "fail", message: ctx.environment.ci === "github" ? tok.none : "this publish gets its OIDC token from GitHub Actions, and this run is not one", fix: "Give the job permissions: id-token: write." });
    return t;
  }
  const ex = await answer(ctx, `${registry}/v0.1/auth/github-oidc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ oidc_token: tok.token }) });
  const value = (ex.json as { registry_token?: unknown } | null)?.registry_token;
  if (typeof value === "string") ctx.redactor.add(value);
  checks.push(
    ex.status === 200 && typeof value === "string"
      ? { check: "mcp-registry-auth", status: "ok", message: `the registry takes this run's GitHub OIDC token` }
      : { check: "mcp-registry-auth", status: "fail", message: `the registry gave no token for this run's OIDC token (${ex.status}${ex.text ? `: ${short(ex.text)}` : ""})`, fix: "Publish from a GitHub Actions job with id-token: write." },
  );
  return t;
}

// Marketplaces

/** The extension's publisher and name: from the `.vsix` when it is built, else from the member's package.json. */
async function extensionIdentity(decl: MarketplacePublishDeclaration, ctx: Ctx): Promise<{ publisher: string; name: string; from: string } | null> {
  const abs = isAbsolute(decl.vsix) ? decl.vsix : resolve(ctx.cwd, decl.vsix);
  if (existsSync(abs)) {
    const { vsixIdentity } = await import("./publish-marketplace");
    try {
      const id = vsixIdentity(readFileSync(abs), decl.vsix);
      return { publisher: id.publisher, name: id.name, from: decl.vsix };
    } catch {
      return null;
    }
  }
  const pkg = join(ctx.cwd, "package.json");
  if (!existsSync(pkg)) return null;
  try {
    const m = JSON.parse(readFileSync(pkg, "utf-8")) as { publisher?: unknown; name?: unknown };
    return typeof m.publisher === "string" && typeof m.name === "string" ? { publisher: m.publisher, name: m.name, from: "package.json" } : null;
  } catch {
    return null;
  }
}

async function checkMarketplace(decl: MarketplacePublishDeclaration, ctx: Ctx): Promise<DoctorTarget> {
  const { OPEN_VSX_REGISTRY, VSCODE_GALLERY, OVSX_ID_TOKEN_ENV, marketplaceTokenEnv } = await import("./publish-marketplace");
  const label = decl.marketplace === "vscode" ? "the VS Code Marketplace" : "Open VSX";
  const registry = (decl.registry ?? (decl.marketplace === "vscode" ? VSCODE_GALLERY : OPEN_VSX_REGISTRY)).replace(/\/+$/, "");
  const checks: DoctorCheck[] = [];
  const t: DoctorTarget = { kind: "marketplace", name: `marketplace ${decl.marketplace}`, checks };
  const id = await extensionIdentity(decl, ctx);
  if (!id) {
    checks.push({ check: "marketplace-identity", status: "unknown", message: `${decl.vsix} is not built, and the member's package.json names no publisher and name, so the extension can't be looked up` });
    return t;
  }
  t.name = `marketplace ${decl.marketplace} ${id.publisher}.${id.name}`;
  const auth = decl.auth ?? "token";
  if (decl.marketplace === "openvsx") {
    const ns = await answer(ctx, `${registry}/api/${encodeURIComponent(id.publisher)}`, { method: "GET", headers: {} });
    checks.push(
      ns.status === 200
        ? { check: "marketplace-namespace", status: "ok", message: `the namespace ${id.publisher} is on ${registry}` }
        : ns.status === 404
          ? { check: "marketplace-namespace", status: "fail", message: `${registry} has no namespace ${id.publisher}`, fix: `Create it: ovsx create-namespace ${id.publisher}.` }
          : { check: "marketplace-namespace", status: "unknown", message: `${registry}/api/${id.publisher} answered ${ns.status}` },
    );
    if (auth === "trusted-publishing") {
      if (!ctx.environment.ci && !ctx.env[OVSX_ID_TOKEN_ENV]) {
        checks.push({ check: "marketplace-trusted-publisher", status: "unknown", message: `whether Open VSX takes this workflow as a trusted publisher of ${id.publisher}.${id.name} can only be tested by ${onlyTheWorkflow(ctx)}, with its OIDC token` });
        return t;
      }
      const tok = await idToken(ctx, registry, OVSX_ID_TOKEN_ENV);
      if ("none" in tok) {
        checks.push({ check: "marketplace-trusted-publisher", status: "fail", message: tok.none, fix: `Give the job permissions: id-token: write, or put an ID token in ${OVSX_ID_TOKEN_ENV}.` });
        return t;
      }
      const ex = await answer(ctx, `${registry}/api/-/trusted-publishing/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ namespace: id.publisher, extension: id.name, token: tok.token }) });
      const value = (ex.json as { value?: unknown } | null)?.value;
      if (typeof value === "string") ctx.redactor.add(value);
      checks.push(
        ex.status >= 200 && ex.status < 300 && typeof value === "string"
          ? { check: "marketplace-trusted-publisher", status: "ok", message: `Open VSX takes this workflow as a trusted publisher of ${id.publisher}.${id.name}` }
          : { check: "marketplace-trusted-publisher", status: "fail", message: `Open VSX gave no trusted-publishing token for ${id.publisher}.${id.name} (${ex.status}${ex.text ? `: ${short(ex.text)}` : ""})`, fix: `Register this workflow at ${registry}/user-settings/trusted-publishers.` },
      );
      return t;
    }
    const names = marketplaceTokenEnv(decl);
    const token = readCredential(ctx.env, names, ctx.redactor);
    checks.push(token ? { check: "marketplace-token", status: "unknown", message: `the token in ${token.from} is set; Open VSX has no read-only check of a token, so whether it may publish to ${id.publisher} shows at the upload` } : missing(ctx, "marketplace-token", `${names[0]} is not set`, `Set ${names[0]} to an Open VSX access token.`));
    return t;
  }
  // The VS Code Marketplace: vsce verify-pat asks the marketplace for the identity's role on the publisher and changes nothing.
  let env: NodeJS.ProcessEnv = { ...ctx.env };
  let args = ["verify-pat", id.publisher];
  if (auth === "azure-credential") {
    delete env.VSCE_PAT;
    args = [...args, "--azure-credential"];
  } else {
    const names = marketplaceTokenEnv(decl);
    const token = readCredential(ctx.env, names, ctx.redactor);
    if (!token) {
      checks.push(missing(ctx, "marketplace-token", `${names[0]} is not set`, `Set ${names[0]} to a personal access token with the Marketplace (Manage) scope.`));
      return t;
    }
    env = { ...env, VSCE_PAT: token.value };
  }
  const r = await ctx.run(ctx.vsce, args, { cwd: ctx.cwd, env }).catch((err: unknown) => ({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
  const said = short((r.stderr || r.stdout).trim().split("\n").at(-1) ?? "");
  checks.push(
    r.code === 0
      ? { check: "marketplace-access", status: "ok", message: `${label} takes the ${auth === "azure-credential" ? "Entra identity" : "token"} for publisher ${id.publisher}` }
      : r.code === 127
        ? { check: "marketplace-access", status: ctx.environment.ci ? "fail" : "unknown", message: `vsce could not be run, so the ${auth === "azure-credential" ? "identity" : "token"} was not checked: ${said}`, fix: "npm install -g @vscode/vsce" }
        : { check: "marketplace-access", status: "fail", message: `vsce verify-pat refused publisher ${id.publisher}: ${said}`, fix: auth === "azure-credential" ? `Add the job's Entra identity to the publisher ${id.publisher} as a member.` : `Give the token the Marketplace (Manage) scope for ${id.publisher}.` },
  );
  return t;
}

// Python and Rust registries (#5167)

async function checkPypi(decl: PypiPublishDeclaration, ctx: Ctx): Promise<DoctorTarget> {
  const { PYPI_ID_TOKEN_ENV, normalizeProjectName, pypiAuth, pypiIndex, pypiProjectName, pypiTokenEnv } = await import("./publish-pypi");
  const index = pypiIndex(decl);
  const checks: DoctorCheck[] = [];
  const name = pypiProjectName(ctx.cwd, decl.files);
  const t: DoctorTarget = { kind: "pypi", name: `pypi ${index.label}${name ? ` ${name}` : ""}`, checks };
  let exists: boolean | null = null;
  if (!name) {
    checks.push({ check: "pypi-project", status: "unknown", message: "no distribution is built and pyproject.toml names no [project] name, so the project can't be looked up" });
  } else {
    const res = await answer(ctx, `${index.simple}${normalizeProjectName(name)}/`, { method: "GET", headers: { accept: "application/vnd.pypi.simple.v1+json" } });
    exists = res.status === 200 ? true : res.status === 404 ? false : null;
    checks.push(
      exists === true
        ? { check: "pypi-project", status: "ok", message: `${index.label} has the project ${name}` }
        : exists === false
          ? { check: "pypi-project", status: "warn", message: `${index.label} has no project ${name} yet; the first upload creates it`, fix: index.site ? `For trusted publishing, add a pending publisher for ${name} at ${index.site}/manage/account/publishing/.` : undefined }
          : { check: "pypi-project", status: "unknown", message: `${index.simple}${normalizeProjectName(name)}/ answered ${res.status}` },
    );
  }
  const auth = pypiAuth(decl, ctx.env);
  if (auth === "token") {
    const tokenName = pypiTokenEnv(decl);
    const token = readCredential(ctx.env, [tokenName], ctx.redactor);
    checks.push(
      token
        ? { check: "pypi-token", status: "unknown", message: `the token in ${tokenName} is set; ${index.label} has no read-only check of a token, so whether it may upload shows at the upload` }
        : missing(ctx, "pypi-token", `${tokenName} is not set${index.site ? " and there is no OIDC ID token for trusted publishing" : ""}`, `Set ${tokenName} to an API token for the project${index.site ? ", or publish with trusted publishing from a CI job with an OIDC ID token" : ""}.`),
    );
    return t;
  }
  if (!ctx.environment.ci && !ctx.env[PYPI_ID_TOKEN_ENV]) {
    checks.push({ check: "pypi-trusted-publisher", status: "unknown", message: `whether ${index.label} takes this workflow as a trusted publisher can only be tested by ${onlyTheWorkflow(ctx)}, with its OIDC token` });
    return t;
  }
  const aud = await answer(ctx, `${index.site}/_/oidc/audience`, { method: "GET", headers: { accept: "application/json" } });
  const audience = (aud.json as { audience?: unknown } | null)?.audience;
  if (typeof audience !== "string") {
    checks.push({ check: "pypi-trusted-publisher", status: "fail", message: `${index.site}/_/oidc/audience answered ${aud.status}, so trusted publishing can't start` });
    return t;
  }
  const tok = await idToken(ctx, audience, PYPI_ID_TOKEN_ENV);
  if ("none" in tok) {
    checks.push({ check: "pypi-trusted-publisher", status: "fail", message: tok.none, fix: `Give the job permissions: id-token: write, or declare ${PYPI_ID_TOKEN_ENV} under the GitLab job's id_tokens with the audience ${audience}.` });
    return t;
  }
  const ex = await answer(ctx, `${index.site}/_/oidc/mint-token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tok.token }) });
  const value = (ex.json as { token?: unknown } | null)?.token;
  if (typeof value === "string") ctx.redactor.add(value);
  checks.push(
    ex.status >= 200 && ex.status < 300 && typeof value === "string"
      ? { check: "pypi-trusted-publisher", status: "ok", message: `${index.label} takes this workflow as a trusted publisher` }
      : { check: "pypi-trusted-publisher", status: "fail", message: `${index.label} gave no upload token for this run (${ex.status}${ex.text ? `: ${short(ex.text)}` : ""})`, fix: `Register this workflow as a trusted publisher${name ? ` of ${name}` : ""} at ${index.site}/manage/account/publishing/.` },
  );
  return t;
}

async function checkCargo(decl: CargoPublishDeclaration, ctx: Ctx): Promise<DoctorTarget> {
  const { CRATES_IO_API, CRATES_IO_AUDIENCE, CRATES_IO_ID_TOKEN_ENV, CRATES_IO_INDEX, cargoAuth, cargoPublishOrder, cargoTokenEnv, cargoWorkspace, sparseIndexPath } = await import("./publish-cargo");
  const label = decl.registry ? `registry ${decl.registry}` : "crates.io";
  const checks: DoctorCheck[] = [];
  const t: DoctorTarget = { kind: "cargo", name: `cargo ${label}`, checks };
  const manifest = resolve(ctx.cwd, decl.manifest ?? "Cargo.toml");
  let names: string[] = [];
  try {
    const crates = cargoPublishOrder(await cargoWorkspace(ctx.cargo, manifest, ctx.cwd, ctx.env, (bin, args, cwd, env) => ctx.run(bin, args, { cwd, env })), decl);
    names = crates.map((c) => c.name);
    t.name = `cargo ${label} ${names.join(", ")}`;
    checks.push({ check: "cargo-crates", status: "ok", message: `publishes ${crates.map((c) => `${c.name}@${c.version}`).join(", ")}, in that order` });
  } catch (err) {
    const code = (err as { code?: string }).code;
    checks.push({ check: "cargo-crates", status: code === "publish-cargo-missing" ? (ctx.environment.ci ? "fail" : "unknown") : "fail", message: err instanceof Error ? err.message : String(err), ...((err as { fix?: string }).fix ? { fix: (err as { fix?: string }).fix } : {}) });
  }
  const index = (decl.index ?? CRATES_IO_INDEX).replace(/^sparse\+/, "").replace(/\/*$/, "/");
  const fresh: string[] = [];
  for (const n of names) {
    const res = await answer(ctx, `${index}${sparseIndexPath(n)}`, { method: "GET", headers: {} });
    if (res.status === 404) fresh.push(n);
  }
  if (fresh.length > 0) checks.push({ check: "cargo-new-crates", status: "warn", message: `${fresh.join(", ")} ${fresh.length === 1 ? "is" : "are"} not on ${label} yet; the first version of a crate needs a token that may publish new crates, and trusted publishing can't make one` });
  const auth = cargoAuth(decl, ctx.env);
  if (auth === "token") {
    const tokenName = cargoTokenEnv(decl);
    const token = readCredential(ctx.env, [tokenName], ctx.redactor);
    checks.push(token ? { check: "cargo-token", status: "unknown", message: `the token in ${tokenName} is set; ${label} has no read-only check of a token, so whether it may publish shows at the publish` } : missing(ctx, "cargo-token", `${tokenName} is not set`, `Set ${tokenName} to a token of ${label}.`));
    return t;
  }
  if (!ctx.environment.ci && !ctx.env[CRATES_IO_ID_TOKEN_ENV]) {
    checks.push({ check: "cargo-trusted-publisher", status: "unknown", message: `whether crates.io takes this workflow as a trusted publisher can only be tested by ${onlyTheWorkflow(ctx)}, with its OIDC token` });
    return t;
  }
  const tok = await idToken(ctx, CRATES_IO_AUDIENCE, CRATES_IO_ID_TOKEN_ENV);
  if ("none" in tok) {
    checks.push({ check: "cargo-trusted-publisher", status: "fail", message: tok.none, fix: "Give the job permissions: id-token: write." });
    return t;
  }
  const api = (decl.api ?? CRATES_IO_API).replace(/\/+$/, "");
  const ex = await answer(ctx, `${api}/api/v1/trusted_publishing/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jwt: tok.token }) });
  const value = (ex.json as { token?: unknown } | null)?.token;
  if (typeof value === "string") {
    ctx.redactor.add(value);
    await answer(ctx, `${api}/api/v1/trusted_publishing/tokens`, { method: "DELETE", headers: { authorization: `Bearer ${value}` } }).catch(() => null);
  }
  checks.push(
    ex.status >= 200 && ex.status < 300 && typeof value === "string"
      ? { check: "cargo-trusted-publisher", status: "ok", message: "crates.io takes this workflow as a trusted publisher; the token it gave was revoked" }
      : { check: "cargo-trusted-publisher", status: "fail", message: `crates.io gave no token for this run (${ex.status}${ex.text ? `: ${short(ex.text)}` : ""})`, fix: "Add this repository and workflow as a trusted publisher in each crate's settings on crates.io." },
  );
  return t;
}
