/** #5161: `chant release doctor` checks each publish target before a cut, and says what it can't observe. */
import { describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseDoctor, type DoctorCheck, type DoctorRun, type DoctorStatus } from "./release-doctor";
import type { PublishDeclaration } from "./publish-declaration";
import type { PublishFetch } from "./release-publish";

type Route = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** A fetch that answers from `routes`, the first that answers, and records every request. */
function fakeFetch(routes: Route[]): { fetch: PublishFetch; calls: Array<{ url: string; method: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetch: PublishFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    for (const r of routes) {
      const a = r(url, init);
      if (!a) continue;
      const text = a.body === undefined ? "" : typeof a.body === "string" ? a.body : JSON.stringify(a.body);
      const headers = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => text };
    }
    return { ok: false, status: 599, headers: { get: () => null }, text: async () => `no route for ${init.method} ${url}` };
  };
  return { fetch, calls };
}

/** An npm (or vsce) that answers from a table of `args.join(" ")` prefixes. */
function fakeRun(table: Record<string, { code: number; stdout?: string; stderr?: string }>): DoctorRun & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (_bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    calls.push(args);
    const key = Object.keys(table).find((k) => args.join(" ").startsWith(k));
    const a = key ? table[key]! : { code: 1, stderr: "npm error code ENEEDAUTH" };
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  }) as unknown as DoctorRun & { calls: string[][] };
  run.calls = calls;
  return run;
}

function member(pkgs: Record<string, Record<string, unknown>> = { "packages/core": { name: "@acme/core", version: "0.0.0" } }): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-doctor-"));
  for (const [path, manifest] of Object.entries(pkgs)) {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path, "package.json"), JSON.stringify(manifest));
  }
  return dir;
}

const REGISTRY = "https://registry.npmjs.org";
const WORKFLOW = ".github/workflows/chant-release.yml";

/** A provenance bundle naming `repository` and `path`, as npm's attestations endpoint serves it. */
function attestations(repository: string, path: string) {
  const statement = { predicate: { buildDefinition: { externalParameters: { workflow: { ref: "refs/tags/v1", repository: `https://github.com/${repository}`, path } } } } };
  return { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] };
}

const packument = (name: string, trusted = true): Route => (url) =>
  url === `${REGISTRY}/${name.replace("/", "%2f")}`
    ? {
        status: 200,
        body: {
          "dist-tags": { latest: "1.3.0" },
          versions: { "1.3.0": { ...(trusted ? { _npmUser: { name: "GitHub Actions", trustedPublisher: { id: "github" } } } : {}), dist: { attestations: { url: `${REGISTRY}/-/npm/v1/attestations/${name}@1.3.0` } } } },
        },
      }
    : undefined;
const provenance = (repository: string, path: string): Route => (url) => (url.includes("/-/npm/v1/attestations/") ? { status: 200, body: attestations(repository, path) } : undefined);

const GH_ENV = {
  GITHUB_ACTIONS: "true",
  CI: "true",
  GITHUB_REPOSITORY: "acme/app",
  GITHUB_WORKFLOW_REF: `acme/app/${WORKFLOW}@refs/heads/main`,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/req?x=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token-abcdef",
};
const idTokenRoute: Route = (url) => (url.startsWith("https://token.actions.example/req") ? { status: 200, body: { value: "github-id-token-123456" } } : undefined);

const npmDecl = (over: Partial<Extract<PublishDeclaration, { type: "npm" }>> = {}): PublishDeclaration => ({ type: "npm", packages: ["packages/core"], registry: REGISTRY, ...over });

function statuses(checks: DoctorCheck[]): Record<string, DoctorStatus> {
  return Object.fromEntries(checks.map((c) => [c.check, c.status]));
}

describe("npm", () => {
  test("from a workstation: the package and its last publisher are read; the record and the dist-tag can't be told, and no OIDC exchange is tried", async () => {
    const { fetch, calls } = fakeFetch([packument("@acme/core"), provenance("acme/app", WORKFLOW)]);
    const report = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env: { GITHUB_REPOSITORY: "acme/app" }, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({}) } });
    expect(report.targets.map((t) => t.name)).toEqual(["npm @acme/core"]);
    expect(statuses(report.targets[0]!.checks)).toEqual({ "npm-registry": "ok", "npm-last-publisher": "ok", "npm-trusted-publisher": "unknown", "npm-token": "warn", "npm-dist-tag": "unknown" });
    expect(report.targets[0]!.checks.find((c) => c.check === "npm-trusted-publisher")!.message).toContain(`only be tested by a run of ${WORKFLOW}`);
    expect(calls.some((c) => c.url.includes("oidc/token/exchange"))).toBe(false);
    expect(report.counts.fail).toBe(0);
  });

  test("in the release workflow's cut job, which has no id-token: write, the OIDC checks can't tell instead of failing (--from cut)", async () => {
    const cutEnv = { GITHUB_ACTIONS: "true", CI: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_WORKFLOW_REF: `acme/app/${WORKFLOW}@refs/heads/main` };
    const routes = [packument("@acme/core"), provenance("acme/app", WORKFLOW)];
    // Without the flag the cut job fails, as it did in a dispatched release.
    const before = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env: cutEnv, releaseWorkflow: WORKFLOW, deps: { fetch: fakeFetch(routes).fetch, run: fakeRun({}) } });
    expect(statuses(before.targets[0]!.checks)).toMatchObject({ "npm-trusted-publisher": "fail", "npm-token": "fail" });
    const report = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env: cutEnv, releaseWorkflow: WORKFLOW, from: "cut", deps: { fetch: fakeFetch(routes).fetch, run: fakeRun({}) } });
    expect(report.environment.from).toBe("cut");
    expect(statuses(report.targets[0]!.checks)).toEqual({ "npm-registry": "ok", "npm-last-publisher": "ok", "npm-trusted-publisher": "unknown", "npm-token": "unknown", "npm-dist-tag": "unknown" });
    expect(report.targets[0]!.checks.find((c) => c.check === "npm-trusted-publisher")!.message).toContain("the publish job's id-token: write");
    expect(report.counts.fail).toBe(0);
    // Other checks still run: a package that is private still fails in the cut job.
    const priv = await releaseDoctor({ cwd: member({ "packages/core": { name: "@acme/core", version: "0.0.0", private: true } }), publish: [npmDecl()], env: cutEnv, releaseWorkflow: WORKFLOW, from: "cut", deps: { fetch: fakeFetch(routes).fetch, run: fakeRun({}) } });
    expect(priv.counts.fail).toBeGreaterThan(0);
  });

  test("the last version published from another workflow file is a warning naming the fix, not a failure", async () => {
    const { fetch } = fakeFetch([packument("@acme/core"), provenance("acme/app", ".github/workflows/publish.yml")]);
    const report = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env: { GITHUB_REPOSITORY: "acme/app" }, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({}) } });
    const c = report.targets[0]!.checks.find((x) => x.check === "npm-last-publisher")!;
    expect(c.status).toBe("warn");
    expect(c.message).toContain(".github/workflows/publish.yml");
    expect(c.fix).toContain("chant-release.yml");
  });

  test("in the release workflow, npm's exchange decides: 201 is ok, 404 fails, a 5xx fails as unanswered, and no token is printed", async () => {
    for (const [status, want] of [[201, "ok"], [404, "fail"], [503, "fail"]] as const) {
      const { fetch, calls } = fakeFetch([
        idTokenRoute,
        (url) => (url === `${REGISTRY}/-/npm/v1/oidc/token/exchange/package/@acme%2fcore` ? { status, body: status === 201 ? { token: "npm-publish-token-xyz" } : { message: "no matching trusted publisher" } } : undefined),
        packument("@acme/core"),
        provenance("acme/app", WORKFLOW),
      ]);
      const report = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env: GH_ENV, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({}) } });
      const c = report.targets[0]!.checks.find((x) => x.check === "npm-trusted-publisher")!;
      expect(c.status, String(status)).toBe(want);
      expect(calls.find((x) => x.url.startsWith("https://token.actions.example"))!.url).toContain("audience=npm%3Aregistry.npmjs.org");
      expect(calls.find((x) => x.url.includes("exchange"))!.headers.authorization).toBe("Bearer github-id-token-123456");
      expect(JSON.stringify(report)).not.toMatch(/npm-publish-token-xyz|github-id-token-123456|request-token-abcdef/);
      expect(report.counts.fail > 0).toBe(want === "fail");
    }
  });

  test("in another workflow of the same repository, the exchange says nothing about the release workflow, so it is not made", async () => {
    const { fetch, calls } = fakeFetch([idTokenRoute, packument("@acme/core"), provenance("acme/app", WORKFLOW)]);
    const env = { ...GH_ENV, GITHUB_WORKFLOW_REF: "acme/app/.github/workflows/ci.yml@refs/heads/main" };
    const report = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({}) } });
    const c = report.targets[0]!.checks.find((x) => x.check === "npm-trusted-publisher")!;
    expect(c.status).toBe("unknown");
    expect(c.message).toContain("this run is .github/workflows/ci.yml");
    expect(calls.some((x) => x.url.includes("exchange"))).toBe(false);
    expect(report.environment.workflow).toBe(".github/workflows/ci.yml");
  });

  test("a package not on the registry fails, with or without a token, and names the refusal the cut gives", async () => {
    const { fetch } = fakeFetch([(url) => (url.startsWith(`${REGISTRY}/@acme%2fcore`) ? { status: 404, body: { error: "Not found" } } : undefined)]);
    const none = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env: {}, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({}) } });
    expect(statuses(none.targets[0]!.checks)["npm-registry"]).toBe("fail");
    const withToken = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env: {}, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({ whoami: { code: 0, stdout: "alice\n" } }) } });
    expect(statuses(withToken.targets[0]!.checks)["npm-registry"]).toBe("fail");
    expect(withToken.targets[0]!.checks.find((c) => c.check === "npm-registry")!.message).toContain("publish-npm-never-published");
  });

  test("a token whose user may write the package can move the dist-tag; read-only fails; stage: false needs no dist-tag", async () => {
    const { fetch } = fakeFetch([packument("@acme/core"), provenance("acme/app", WORKFLOW)]);
    const rw = fakeRun({ whoami: { code: 0, stdout: "alice\n" }, "access list collaborators @acme/core": { code: 0, stdout: JSON.stringify({ alice: "read-write" }) } });
    const ok = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env: {}, releaseWorkflow: WORKFLOW, deps: { fetch, run: rw } });
    expect(statuses(ok.targets[0]!.checks)).toMatchObject({ "npm-token": "ok", "npm-dist-tag": "ok" });
    expect(rw.calls.find((a) => a[0] === "access")).toEqual(["access", "list", "collaborators", "@acme/core", "--json", "--registry", REGISTRY]);
    const ro = await releaseDoctor({ cwd: member(), publish: [npmDecl()], env: {}, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({ whoami: { code: 0, stdout: "bob" }, "access list": { code: 0, stdout: JSON.stringify({ bob: "read-only" }) } }) } });
    expect(statuses(ro.targets[0]!.checks)["npm-token"]).toBe("fail");
    const unstaged = await releaseDoctor({ cwd: member(), publish: [npmDecl({ stage: false })], env: {}, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({}) } });
    expect(statuses(unstaged.targets[0]!.checks)["npm-dist-tag"]).toBeUndefined();
  });

  test("a private package and a directory with no package.json fail before any request", async () => {
    const { fetch, calls } = fakeFetch([]);
    const cwd = member({ "packages/core": { name: "@acme/core", private: true } });
    const report = await releaseDoctor({ cwd, publish: [npmDecl({ packages: ["packages/core", "packages/gone"] })], env: {}, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({}) } });
    expect(report.targets.map((t) => statuses(t.checks)["npm-package"])).toEqual(["fail", "fail"]);
    expect(calls).toEqual([]);
  });

  test("with no registry declared, npm's own config names it", async () => {
    const { fetch, calls } = fakeFetch([(url) => (url.startsWith("https://npm.example/") ? { status: 404 } : undefined)]);
    await releaseDoctor({ cwd: member(), publish: [{ type: "npm", packages: ["packages/core"] }], env: {}, releaseWorkflow: WORKFLOW, deps: { fetch, run: fakeRun({ "config get registry": { code: 0, stdout: "https://npm.example/\n" } }) } });
    expect(calls[0]!.url).toBe("https://npm.example/@acme%2fcore");
  });
});

/** A JWT whose claims are `claims`, unsigned, as a registry's token service hands one out. */
const jwt = (claims: unknown) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("oci", () => {
  const decl: PublishDeclaration = { type: "oci", image: "dist/api.oci.tar", repository: "docker.io/acme/api" };
  const bearer = (token: string): Route[] => [
    (url) => (url === "https://registry-1.docker.io/v2/" ? { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } } : undefined),
    (url) => (url.startsWith("https://auth.docker.io/token") ? { status: 200, body: { token } } : undefined),
  ];

  test("a token that grants push is ok; one that grants pull only fails; the scope asked is pull,push", async () => {
    const env = { OCI_USERNAME: "acme", OCI_PASSWORD: "hub-password-123" };
    const push = fakeFetch(bearer(jwt({ access: [{ type: "repository", name: "acme/api", actions: ["pull", "push"] }] })));
    const ok = await releaseDoctor({ cwd: member({}), publish: [decl], env, releaseWorkflow: null, deps: { fetch: push.fetch } });
    expect(statuses(ok.targets[0]!.checks)).toEqual({ "oci-credentials": "ok", "oci-push": "ok" });
    expect(decodeURIComponent(push.calls[1]!.url)).toContain("scope=repository:acme/api:pull,push");
    const pull = fakeFetch(bearer(jwt({ access: [{ type: "repository", name: "acme/api", actions: ["pull"] }] })));
    const no = await releaseDoctor({ cwd: member({}), publish: [decl], env, releaseWorkflow: null, deps: { fetch: pull.fetch } });
    expect(statuses(no.targets[0]!.checks)["oci-push"]).toBe("fail");
    expect(JSON.stringify(no)).not.toContain("hub-password-123");
  });

  test("an opaque token can't say what it grants; no credentials in CI fails", async () => {
    const opaque = fakeFetch(bearer("opaque-token-value"));
    const r = await releaseDoctor({ cwd: member({}), publish: [decl], env: { OCI_PASSWORD: "pw-12345" }, releaseWorkflow: null, deps: { fetch: opaque.fetch } });
    expect(statuses(r.targets[0]!.checks)["oci-push"]).toBe("unknown");
    const none = await releaseDoctor({ cwd: member({}), publish: [decl], env: { CI: "true", HOME: "/nonexistent" }, releaseWorkflow: null, deps: { fetch: fakeFetch(bearer("t")).fetch } });
    expect(statuses(none.targets[0]!.checks)["oci-credentials"]).toBe("fail");
  });
});

describe("forges", () => {
  const gh: PublishDeclaration = { type: "forge", forge: "github", repo: "acme/app", assets: ["dist/a.tgz"] };

  test("GitHub: write permission is ok, read only fails, a token with no permissions or scopes can't be told", async () => {
    const cases: Array<[unknown, Record<string, string>, DoctorStatus]> = [
      [{ permissions: { push: true } }, {}, "ok"],
      [{ permissions: { push: false } }, {}, "fail"],
      [{}, { "x-oauth-scopes": "read:org" }, "fail"],
      [{}, { "x-oauth-scopes": "repo, read:org" }, "ok"],
      [{}, {}, "unknown"],
    ];
    for (const [body, headers, want] of cases) {
      const { fetch, calls } = fakeFetch([(url) => (url === "https://api.github.com/repos/acme/app" ? { status: 200, body, headers } : undefined)]);
      const r = await releaseDoctor({ cwd: member({}), publish: [gh], env: { GITHUB_TOKEN: "ghs_token_abc" }, releaseWorkflow: null, deps: { fetch } });
      expect(statuses(r.targets[0]!.checks), JSON.stringify([body, headers])).toEqual({ "forge-token": "ok", "forge-access": want });
      expect(calls[0]!.method).toBe("GET");
    }
  });

  test("a missing token warns on a workstation and fails in CI; Forgejo with no API root fails", async () => {
    const { fetch } = fakeFetch([]);
    const ws = await releaseDoctor({ cwd: member({}), publish: [gh], env: {}, releaseWorkflow: null, deps: { fetch } });
    expect(statuses(ws.targets[0]!.checks)["forge-token"]).toBe("warn");
    const ci = await releaseDoctor({ cwd: member({}), publish: [gh], env: { CI: "true" }, releaseWorkflow: null, deps: { fetch } });
    expect(statuses(ci.targets[0]!.checks)["forge-token"]).toBe("fail");
    const fj = await releaseDoctor({ cwd: member({}), publish: [{ type: "forge", forge: "forgejo", repo: "acme/app", assets: ["a"] }], env: { FORGEJO_TOKEN: "fj-token" }, releaseWorkflow: null, deps: { fetch } });
    expect(statuses(fj.targets[0]!.checks)["forge-api"]).toBe("fail");
  });

  test("GitLab: a job token can't be read; a token without api fails; Developer on the project is ok", async () => {
    const gl: PublishDeclaration = { type: "forge", forge: "gitlab", repo: "acme/app", assets: ["a"] };
    const job = await releaseDoctor({ cwd: member({}), publish: [gl], env: { CI_JOB_TOKEN: "job-token-1" }, releaseWorkflow: null, deps: { fetch: fakeFetch([]).fetch } });
    expect(statuses(job.targets[0]!.checks)["forge-access"]).toBe("unknown");
    const self = (scopes: string[]): Route => (url) => (url.endsWith("/personal_access_tokens/self") ? { status: 200, body: { scopes } } : undefined);
    const proj: Route = (url) => (url === "https://gitlab.com/api/v4/projects/acme%2Fapp" ? { status: 200, body: { permissions: { project_access: { access_level: 30 }, group_access: null } } } : undefined);
    const read = await releaseDoctor({ cwd: member({}), publish: [gl], env: { GITLAB_TOKEN: "glpat-1" }, releaseWorkflow: null, deps: { fetch: fakeFetch([self(["read_api"]), proj]).fetch } });
    expect(statuses(read.targets[0]!.checks)["forge-access"]).toBe("fail");
    const api = await releaseDoctor({ cwd: member({}), publish: [gl], env: { GITLAB_TOKEN: "glpat-1" }, releaseWorkflow: null, deps: { fetch: fakeFetch([self(["api"]), proj]).fetch } });
    expect(statuses(api.targets[0]!.checks)["forge-access"]).toBe("ok");
  });

  test("homebrew over SSH can't show write access before a push", async () => {
    const r = await releaseDoctor({
      cwd: member({}),
      publish: [{ type: "homebrew", tap: "acme/homebrew-tap", formula: "Formula/a.rb", template: "a.rb", assets: ["a"], url: "https://x/{name}", sshKeyEnv: "TAP_KEY" }],
      env: { TAP_KEY: "-----BEGIN KEY-----" },
      releaseWorkflow: null,
      deps: { fetch: fakeFetch([]).fetch },
    });
    expect(statuses(r.targets[0]!.checks)).toEqual({ "homebrew-access": "unknown" });
  });
});

describe("marketplaces", () => {
  const ext = () => member({ ".": { name: "acme-ext", publisher: "acme", version: "0.0.0" } });

  test("Open VSX: a missing namespace fails; trusted publishing is exchanged in CI and can't be told on a workstation", async () => {
    const decl: PublishDeclaration = { type: "marketplace", marketplace: "openvsx", vsix: "dist/acme.vsix", auth: "trusted-publishing" };
    const nsMissing = fakeFetch([(url) => (url === "https://open-vsx.org/api/acme" ? { status: 404 } : undefined)]);
    const ws = await releaseDoctor({ cwd: ext(), publish: [decl], env: {}, releaseWorkflow: WORKFLOW, deps: { fetch: nsMissing.fetch } });
    expect(ws.targets[0]!.name).toBe("marketplace openvsx acme.acme-ext");
    expect(statuses(ws.targets[0]!.checks)).toEqual({ "marketplace-namespace": "fail", "marketplace-trusted-publisher": "unknown" });
    const { fetch, calls } = fakeFetch([
      (url) => (url === "https://open-vsx.org/api/acme" ? { status: 200, body: {} } : undefined),
      idTokenRoute,
      (url) => (url === "https://open-vsx.org/api/-/trusted-publishing/token" ? { status: 200, body: { value: "ovsx-short-token" } } : undefined),
    ]);
    const ci = await releaseDoctor({ cwd: ext(), publish: [decl], env: GH_ENV, releaseWorkflow: WORKFLOW, deps: { fetch } });
    expect(statuses(ci.targets[0]!.checks)).toEqual({ "marketplace-namespace": "ok", "marketplace-trusted-publisher": "ok" });
    expect(calls.find((c) => c.url.startsWith("https://token.actions.example"))!.url).toContain("audience=https%3A%2F%2Fopen-vsx.org");
    expect(JSON.stringify(ci)).not.toContain("ovsx-short-token");
  });

  test("VS Code Marketplace: vsce verify-pat decides, with the token in VSCE_PAT", async () => {
    const decl: PublishDeclaration = { type: "marketplace", marketplace: "vscode", vsix: "dist/acme.vsix" };
    let seen: NodeJS.ProcessEnv = {};
    const run: DoctorRun = async (_bin, args, opts) => {
      seen = opts.env;
      return args.join(" ") === "verify-pat acme" ? { code: 0, stdout: "The PAT is valid", stderr: "" } : { code: 1, stdout: "", stderr: "bad" };
    };
    const r = await releaseDoctor({ cwd: ext(), publish: [decl], env: { VSCE_PAT: "pat-value-1" }, releaseWorkflow: null, deps: { fetch: fakeFetch([]).fetch, run } });
    expect(statuses(r.targets[0]!.checks)).toEqual({ "marketplace-access": "ok" });
    expect(seen.VSCE_PAT).toBe("pat-value-1");
    const refused = await releaseDoctor({ cwd: ext(), publish: [decl], env: { VSCE_PAT: "pat" }, releaseWorkflow: null, deps: { fetch: fakeFetch([]).fetch, run: async () => ({ code: 1, stdout: "", stderr: "ERROR  Access Denied" }) } });
    expect(statuses(refused.targets[0]!.checks)["marketplace-access"]).toBe("fail");
  });
});

describe("release.green forge-checks (#5149)", () => {
  const SHA = "a".repeat(40);
  const GH = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_API_URL: "https://api.github.com", GITHUB_TOKEN: "ghs-job-token" };
  const checksRoute = (status: number): Route => (url) =>
    url.startsWith(`https://api.github.com/repos/acme/app/commits/${SHA}/check-runs`)
      ? { status, body: status === 200 ? { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] } : { message: "Resource not accessible by integration" } }
      : url.startsWith(`https://api.github.com/repos/acme/app/commits/${SHA}/status`)
        ? { status, body: status === 200 ? { statuses: [] } : {} }
        : undefined;

  test("the token that reads the commit's checks and statuses is ok; one refused fails naming checks: read; no token fails in CI", async () => {
    const ok = await releaseDoctor({ cwd: member({}), publish: [], env: GH, releaseWorkflow: null, green: "forge-checks", commit: SHA, deps: { fetch: fakeFetch([checksRoute(200)]).fetch } });
    expect(ok.targets.map((t) => t.kind)).toEqual(["green"]);
    expect(statuses(ok.targets[0]!.checks)).toEqual({ "green-forge-checks": "ok" });
    expect(ok.targets[0]!.checks[0]!.message).toContain("GITHUB_TOKEN");
    const refused = await releaseDoctor({ cwd: member({}), publish: [], env: GH, releaseWorkflow: null, green: "forge-checks", commit: SHA, deps: { fetch: fakeFetch([checksRoute(403)]).fetch } });
    expect(statuses(refused.targets[0]!.checks)).toEqual({ "green-forge-checks": "fail" });
    expect(refused.targets[0]!.checks[0]!.fix).toContain("checks: read");
    expect(refused.counts.fail).toBe(1);
    const { GITHUB_TOKEN: _, ...noToken } = GH;
    const none = await releaseDoctor({ cwd: member({}), publish: [], env: noToken, releaseWorkflow: null, green: "forge-checks", commit: SHA, deps: { fetch: fakeFetch([]).fetch } });
    expect(statuses(none.targets[0]!.checks)).toEqual({ "green-forge-checks": "fail" });
  });

  test("the chant and none gates add no check", async () => {
    for (const green of ["chant", "none"] as const) {
      const r = await releaseDoctor({ cwd: member({}), publish: [], env: GH, releaseWorkflow: null, green, commit: SHA, deps: { fetch: fakeFetch([]).fetch } });
      expect(r.targets).toEqual([]);
    }
  });
});

describe("an artifact release (#5149)", () => {
  test("a project with only package.json and chant.config.ts, no environments and no chant.workspace.json, has its targets checked", async () => {
    const root = member({ ".": { name: "acme-cli", version: "0.0.0" } });
    writeFileSync(
      join(root, "chant.config.ts"),
      `export default { release: { green: "none", publish: [{ type: "forge", forge: "github", repo: "acme/acme", tokenEnv: "CHANT_DOCTOR_TEST_NO_SUCH_TOKEN", assets: ["dist/acme"] }] } };\n`,
    );
    const { runReleaseDoctor } = await import("../cli/handlers/release-doctor");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((l: string) => void out.push(l));
    try {
      await runReleaseDoctor({ args: { json: true } } as unknown as Parameters<typeof runReleaseDoctor>[0]);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
    }
    const report = JSON.parse(out.join("\n")) as { targets: Array<{ name: string; checks: DoctorCheck[] }> };
    expect(report.targets.map((t) => t.name)).toEqual(["forge github acme/acme"]);
    expect(report.targets[0]!.checks[0]!.check).toBe("forge-token");
  });
});

describe("Sigstore signing (#5164)", () => {
  const forgeDecl = { type: "forge", forge: "github", repo: "acme/app", assets: [] } as unknown as PublishDeclaration;
  const signing = (env: NodeJS.ProcessEnv, signer: { name: string; unavailable: () => string | null }, over: { signing?: boolean; groups?: Set<"supply-chain"> } = { signing: true }) =>
    releaseDoctor({ cwd: mkdtempSync(join(tmpdir(), "chant-doctor-signing-")), publish: [forgeDecl], env, releaseWorkflow: null, ...over, deps: { fetch: fakeFetch([]).fetch, signer } }).then((r) => r.targets.find((t) => t.kind === "signing"));
  const cosign = { name: "cosign v3.1.4", unavailable: () => null };
  const ghEnv = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app", ACTIONS_ID_TOKEN_REQUEST_URL: "https://t", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x" };

  test("reports the OIDC identity and cosign when the publish signs, and nothing when it does not", async () => {
    const ok = await signing(ghEnv, cosign);
    expect(ok?.checks.map((c) => [c.check, c.status])).toEqual([["signing-oidc", "ok"], ["signing-cosign", "ok"]]);
    expect(ok?.checks[0]!.message).toContain("acme/app");
    expect(await signing(ghEnv, cosign, {})).toBeUndefined();
    expect(await signing(ghEnv, cosign, { groups: new Set(["supply-chain"]) })).toBeDefined();
  });

  test("fails in CI without an OIDC token or cosign, and warns on a workstation", async () => {
    const noTool = { name: "cosign", unavailable: () => "cosign is not there" };
    const ci = await signing({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app" }, noTool);
    expect(ci?.checks.map((c) => [c.check, c.status])).toEqual([["signing-oidc", "fail"], ["signing-cosign", "fail"]]);
    const ws = await signing({}, noTool);
    expect(ws?.checks.map((c) => c.status)).toEqual(["warn", "warn"]);
  });
});

describe("pypi and cargo (#5167)", () => {
  const status = (checks: DoctorCheck[], name: string): DoctorStatus | undefined => checks.find((c) => c.check === name)?.status;
  const GHA = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/kit", ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha.test/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gha-request" };

  test("pypi: the project from pyproject.toml, a missing token, and the trusted-publishing exchange in CI", async () => {
    const dir = member({});
    writeFileSync(join(dir, "pyproject.toml"), '[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "Acme_Kit"\nversion = "0"\n');
    const { fetch, calls } = fakeFetch([
      (url) => (url === "https://pypi.org/simple/acme-kit/" ? { status: 404 } : undefined),
      (url) => (url === "https://pypi.org/_/oidc/audience" ? { status: 200, body: { audience: "pypi" } } : undefined),
      (url) => (url.startsWith("https://gha.test/token") && url.includes("audience=pypi") ? { status: 200, body: { value: "gha-id-for-pypi" } } : undefined),
      (url, init) => (url === "https://pypi.org/_/oidc/mint-token" ? (JSON.parse(init.body as string).token === "gha-id-for-pypi" ? { status: 200, body: { token: "pypi-minted" } } : { status: 422 }) : undefined),
    ]);
    const publish: PublishDeclaration[] = [{ type: "pypi", files: ["dist"] }];
    const local = await releaseDoctor({ cwd: dir, publish, env: {}, releaseWorkflow: WORKFLOW, deps: { fetch } });
    expect(local.targets[0]!.name).toBe("pypi PyPI Acme_Kit");
    expect(status(local.targets[0]!.checks, "pypi-project")).toBe("warn");
    expect(status(local.targets[0]!.checks, "pypi-token")).toBe("warn");
    const ci = await releaseDoctor({ cwd: dir, publish, env: GHA, releaseWorkflow: WORKFLOW, deps: { fetch } });
    expect(status(ci.targets[0]!.checks, "pypi-trusted-publisher")).toBe("ok");
    expect(JSON.stringify(ci)).not.toContain("pypi-minted");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/legacy/"))).toBe(false);
  });

  test("cargo: the crates in order, a crate not on the registry yet, and the trusted-publishing exchange revoked", async () => {
    const dir = member({});
    const workspace = {
      packages: [
        { name: "acme-cli", version: "1.0.0", publish: null, dependencies: [{ name: "acme-core", req: "^1.0.0", kind: null, path: "/x" }] },
        { name: "acme-core", version: "1.0.0", publish: null, dependencies: [] },
      ],
    };
    const run = fakeRun({ "metadata --no-deps": { code: 0, stdout: JSON.stringify(workspace) } });
    const { fetch, calls } = fakeFetch([
      (url) => (url === "https://index.crates.io/ac/me/acme-core" ? { status: 200, body: '{"name":"acme-core","vers":"0.9.0"}' } : undefined),
      (url) => (url === "https://index.crates.io/ac/me/acme-cli" ? { status: 404 } : undefined),
      (url) => (url.startsWith("https://gha.test/token") && url.includes("audience=crates.io") ? { status: 200, body: { value: "gha-id-for-crates" } } : undefined),
      (url, init) => (url === "https://crates.io/api/v1/trusted_publishing/tokens" ? (init.method === "POST" ? { status: 200, body: { token: "cio-minted" } } : { status: 204 }) : undefined),
    ]);
    const publish: PublishDeclaration[] = [{ type: "cargo" }];
    const local = await releaseDoctor({ cwd: dir, publish, env: { CARGO_REGISTRY_TOKEN: "cio-secret" }, releaseWorkflow: WORKFLOW, deps: { fetch, run } });
    const checks = local.targets[0]!.checks;
    expect(checks.find((c) => c.check === "cargo-crates")!.message).toContain("acme-core@1.0.0, acme-cli@1.0.0");
    expect(status(checks, "cargo-new-crates")).toBe("warn");
    expect(status(checks, "cargo-token")).toBe("unknown");
    const ci = await releaseDoctor({ cwd: dir, publish, env: GHA, releaseWorkflow: WORKFLOW, deps: { fetch, run } });
    expect(status(ci.targets[0]!.checks, "cargo-trusted-publisher")).toBe("ok");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(JSON.stringify(ci)).not.toContain("cio-minted");
  });
});

describe("maven, nuget and rubygems (#5232)", () => {
  const status = (checks: DoctorCheck[], name: string): DoctorStatus | undefined => checks.find((c) => c.check === name)?.status;
  const GHA = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/kit", ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha.test/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gha-request" };

  test("maven: a bundle not built yet, and the user token", async () => {
    const dir = member({});
    const { fetch } = fakeFetch([]);
    const publish: PublishDeclaration[] = [{ type: "maven", bundle: "artifact:maven" }];
    const r = await releaseDoctor({ cwd: dir, publish, env: { MAVEN_CENTRAL_USERNAME: "u-123", MAVEN_CENTRAL_PASSWORD: "p-123" }, releaseWorkflow: WORKFLOW, deps: { fetch } });
    expect(status(r.targets[0]!.checks, "maven-bundle")).toBe("unknown");
    expect(status(r.targets[0]!.checks, "maven-token")).toBe("unknown");
    const none = await releaseDoctor({ cwd: dir, publish, env: { CI: "true" }, releaseWorkflow: WORKFLOW, deps: { fetch } });
    expect(status(none.targets[0]!.checks, "maven-token")).toBe("fail");
  });

  test("nuget: a missing user, and the trusted-publishing exchange in CI", async () => {
    const dir = member({});
    const { fetch } = fakeFetch([
      (url) => (url.startsWith("https://gha.test/token") && url.includes(encodeURIComponent("https://www.nuget.org")) ? { status: 200, body: { value: "gha-id-for-nuget" } } : undefined),
      (url, init) => (url === "https://www.nuget.org/api/v2/token" ? (init.headers.authorization === "Bearer gha-id-for-nuget" && JSON.parse(init.body as string).username === "acme-bot" ? { status: 200, body: { apiKey: "nuget-minted" } } : { status: 401 }) : undefined),
    ]);
    const publish: PublishDeclaration[] = [{ type: "nuget", packages: ["artifact:nuget"], auth: "trusted-publishing" }];
    const noUser = await releaseDoctor({ cwd: dir, publish, env: GHA, releaseWorkflow: WORKFLOW, deps: { fetch } });
    expect(status(noUser.targets[0]!.checks, "nuget-trusted-publisher")).toBe("fail");
    const ci = await releaseDoctor({ cwd: dir, publish, env: { ...GHA, NUGET_USER: "acme-bot" }, releaseWorkflow: WORKFLOW, deps: { fetch } });
    expect(status(ci.targets[0]!.checks, "nuget-trusted-publisher")).toBe("ok");
    expect(JSON.stringify(ci)).not.toContain("nuget-minted");
  });

  test("rubygems: the gem from its gemspec, not on RubyGems.org yet, and the exchange in CI", async () => {
    const dir = member({});
    writeFileSync(join(dir, "acme.gemspec"), 'Gem::Specification.new { |s| s.name = "acme-kit" }\n');
    const { fetch } = fakeFetch([
      (url) => (url === "https://rubygems.org/api/v1/versions/acme-kit.json" ? { status: 404 } : undefined),
      (url) => (url.startsWith("https://gha.test/token") && url.includes("audience=rubygems.org") ? { status: 200, body: { value: "gha-id-for-gems" } } : undefined),
      (url) => (url === "https://rubygems.org/api/v1/oidc/trusted_publisher/exchange_token" ? { status: 201, body: { rubygems_api_key: "gems-minted" } } : undefined),
    ]);
    const publish: PublishDeclaration[] = [{ type: "rubygems", gems: ["artifact:gem"] }];
    const local = await releaseDoctor({ cwd: dir, publish, env: {}, releaseWorkflow: WORKFLOW, deps: { fetch } });
    expect(local.targets[0]!.name).toBe("rubygems RubyGems.org acme-kit");
    expect(status(local.targets[0]!.checks, "rubygems-gem")).toBe("warn");
    expect(status(local.targets[0]!.checks, "rubygems-token")).toBe("warn");
    const ci = await releaseDoctor({ cwd: dir, publish, env: GHA, releaseWorkflow: WORKFLOW, deps: { fetch } });
    expect(status(ci.targets[0]!.checks, "rubygems-trusted-publisher")).toBe("ok");
    expect(JSON.stringify(ci)).not.toContain("gems-minted");
  });
});
