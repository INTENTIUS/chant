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
  ForgePublishDeclaration,
  HomebrewPublishDeclaration,
  MarketplacePublishDeclaration,
  NpmPublishDeclaration,
  OciPublishDeclaration,
  PublishDeclaration,
  TauriUpdaterPublishDeclaration,
} from "./publish-declaration";
import type { PublishFetch } from "./release-publish";

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
  if (!setting.on || !publish.some((d) => d.type === "oci" || d.type === "forge")) return null;
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
        status: user ? "warn" : "fail",
        message: `${name} is not on ${registry} yet. npm makes its first version latest as soon as it stages, and trusted publishing can't publish it, since a trusted publisher is set on a package that exists${user ? `; npm's config here signs in as ${user}, which can publish it` : ""}`,
        fix: `Publish the first version with a token (npm login, or the npm config the job reads), then add the trusted publisher on ${npmjs ? "npmjs.com under the package's Settings" : "the registry"}.`,
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
