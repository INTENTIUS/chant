/**
 * #5162: the MCP Registry target against a fake registry on 127.0.0.1 that
 * speaks the API's auth, versions and publish endpoints. Nothing reaches the
 * real registry.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createRedactor } from "./publish-credentials";
import { McpRegistryPublishSchema, PublishDeclarationSchema, type McpRegistryPublishDeclaration } from "./publish-declaration";
import { checkServerJson, mcpRegistryAudience } from "./publish-mcp-registry";
import { createPublishTargets } from "./publish-targets";
import { PublishTargetError, revealOrder, runPublish, type PublishContext, type PublishTarget } from "./release-publish";
import { releaseDoctor } from "./release-doctor";
import { unstagedForVerify, verifySteps, type VerifyRunner } from "./publish-verify";
import { makeRelease } from "./release-store";

const dirs: string[] = [];
let server: Server;
let base = "";
let held: Map<string, unknown>;
let requests: Array<{ method: string; url: string; auth: string | undefined; body: string }>;
let oidcAudiences: string[];
let refuse: { status: number; detail: string } | null;

beforeEach(async () => {
  held = new Map();
  requests = [];
  oidcAudiences = [];
  refuse = null;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const url = new URL(req.url ?? "/", base);
      requests.push({ method: req.method ?? "", url: url.pathname, auth: req.headers.authorization, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (url.pathname === "/token") {
        oidcAudiences.push(url.searchParams.get("audience") ?? "");
        return send(200, { value: "gha-oidc-jwt" });
      }
      if (url.pathname === "/v0.1/auth/github-oidc") return send(body.includes("gha-oidc-jwt") ? 200 : 401, { registry_token: "reg-token-xyz", expires_at: 1 });
      if (url.pathname === "/v0.1/auth/github-at") return send(body.includes("ghp_good") ? 200 : 401, { registry_token: "reg-token-xyz", expires_at: 1 });
      if (url.pathname === "/v0.1/publish") {
        if (req.headers.authorization !== "Bearer reg-token-xyz") return send(401, { detail: "bad token" });
        if (refuse) return send(refuse.status, { detail: refuse.detail });
        const s = JSON.parse(body) as { name: string; version: string };
        held.set(`${s.name}@${s.version}`, s);
        return send(200, { server: s, _meta: {} });
      }
      const m = /^\/v0\.1\/servers\/([^/]+)\/versions(?:\/([^/]+))?$/.exec(url.pathname);
      if (m) {
        const name = decodeURIComponent(m[1]!);
        if (!m[2]) return [...held.keys()].some((k) => k.startsWith(`${name}@`)) ? send(200, { servers: [] }) : send(404, { title: "Not Found" });
        const found = held.get(`${name}@${decodeURIComponent(m[2])}`);
        return found ? send(200, { server: found, _meta: {} }) : send(404, { title: "Not Found" });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SERVER = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "io.github.acme/mcp",
    version: "1.4.0",
    description: "Acme",
    packages: [{ registryType: "npm", identifier: "@acme/mcp", version: "1.4.0", transport: { type: "stdio" } }, { registryType: "oci", identifier: "ghcr.io/acme/mcp:1.4.0" }],
    ...over,
  });

function member(json: string): string {
  const d = mkdtempSync(join(tmpdir(), "chant-publish-mcp-registry-"));
  dirs.push(d);
  writeFileSync(join(d, "server.json"), json);
  return d;
}

function context(cwd: string, env: NodeJS.ProcessEnv, label = "1.4.0"): PublishContext & { lines: string[] } {
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: [], targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label, releaseTag: `release/${label}`, provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), lines };
}

const oidcEnv = () => ({ ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token?api=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-secret" });

async function make(decl: Partial<McpRegistryPublishDeclaration> = {}): Promise<PublishTarget> {
  const [t] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "mcp-registry", registry: base, ...decl })]);
  return t!;
}

async function refused(p: Promise<unknown>): Promise<PublishTargetError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PublishTargetError) return err;
    throw err;
  }
  throw new Error("expected a PublishTargetError");
}

describe("the declaration", () => {
  test("takes server, registry, auth and tokenEnv, and nothing else", () => {
    expect(McpRegistryPublishSchema.safeParse({ type: "mcp-registry" }).success).toBe(true);
    expect(McpRegistryPublishSchema.safeParse({ type: "mcp-registry", server: "a/server.json", registry: "https://r.example", auth: "github-token", tokenEnv: "X" }).success).toBe(true);
    expect(McpRegistryPublishSchema.safeParse({ type: "mcp-registry", auth: "password" }).success).toBe(false);
    expect(McpRegistryPublishSchema.safeParse({ type: "mcp-registry", token: "x" }).success).toBe(false);
  });

  test("tokenEnv beside github-oidc is refused", async () => {
    await expect(createPublishTargets([PublishDeclarationSchema.parse({ type: "mcp-registry", tokenEnv: "X" })])).rejects.toMatchObject({ code: "publish-mcp-registry-auth-invalid" });
  });

  test("the audience is the registry's origin", () => {
    expect(mcpRegistryAudience("https://Registry.ModelContextProtocol.io/")).toBe("https://registry.modelcontextprotocol.io");
  });
});

describe("the server.json is checked against the release label", () => {
  const code = (json: string, label: string | null = "1.4.0") => {
    try {
      checkServerJson(json, "server.json", label);
    } catch (e) {
      return (e as PublishTargetError).code;
    }
    return null;
  };
  test("a matching file passes, and a v-prefixed label is read from its first digit", () => {
    expect(code(SERVER())).toBeNull();
    expect(code(SERVER(), "v1.4.0")).toBeNull();
  });
  test("a version that is not the label is refused", () => {
    expect(code(SERVER({ version: "1.3.0" }))).toBe("publish-mcp-registry-version-mismatch");
    expect(code(SERVER(), null)).toBe("publish-mcp-registry-version-mismatch");
  });
  test("a package at another version, with no version, or an image at another tag is refused", () => {
    expect(code(SERVER({ packages: [{ registryType: "npm", identifier: "@acme/mcp", version: "1.3.0" }] }))).toBe("publish-mcp-registry-package-mismatch");
    expect(code(SERVER({ packages: [{ registryType: "pypi", identifier: "acme-mcp" }] }))).toBe("publish-mcp-registry-package-mismatch");
    expect(code(SERVER({ packages: [{ registryType: "oci", identifier: "ghcr.io/acme/mcp:latest" }] }))).toBe("publish-mcp-registry-package-mismatch");
    expect(code(SERVER({ packages: [{ registryType: "oci", identifier: "ghcr.io/acme/mcp" }] }))).toBe("publish-mcp-registry-package-mismatch");
    expect(code(SERVER({ packages: [{ registryType: "oci", identifier: "ghcr.io/acme/mcp@sha256:" + "a".repeat(64) }] }))).toBeNull();
    expect(code(SERVER({ packages: [] }))).toBeNull();
  });
  test("a file that is not a server.json is refused", () => {
    expect(code("{")).toBe("publish-mcp-registry-server-invalid");
    expect(code("{}")).toBe("publish-mcp-registry-server-invalid");
  });
});

describe("the target against a fake registry", () => {
  test("GitHub OIDC: the stage sends nothing, the reveal exchanges and publishes, and the token is masked", async () => {
    const cwd = member(SERVER());
    const t = await make();
    const ctx = context(cwd, oidcEnv());
    expect(t.revealsLast).toBe(true);
    expect(t.uploadsAtReveal).toBe(true);
    expect((await t.plan(ctx))[0]!.name).toBe("io.github.acme/mcp@1.4.0");
    const staged = await t.stage(ctx);
    expect(held.size).toBe(0);
    expect(requests.some((r) => r.url === "/v0.1/publish")).toBe(false);
    const done = await t.reveal(ctx, staged);
    expect(done.items[0]!.present).toBeUndefined();
    expect(held.has("io.github.acme/mcp@1.4.0")).toBe(true);
    expect(oidcAudiences.every((a) => a === base)).toBe(true);
    const publish = requests.find((r) => r.url === "/v0.1/publish")!;
    expect(publish.auth).toBe("Bearer reg-token-xyz");
    expect(JSON.parse(publish.body).version).toBe("1.4.0");
    expect(ctx.redactor.redact("reg-token-xyz gha-oidc-jwt")).toBe("[redacted] [redacted]");
  });

  test("run again: the version is there, so nothing is sent twice", async () => {
    const cwd = member(SERVER());
    const t = await make();
    const ctx = context(cwd, oidcEnv());
    await t.reveal(ctx, await t.stage(ctx));
    const before = requests.filter((r) => r.url === "/v0.1/publish").length;
    const again = await t.stage(ctx);
    expect(again.items[0]!.present).toBe(true);
    const done = await t.reveal(ctx, again);
    expect(done.items[0]!.present).toBe(true);
    expect(requests.filter((r) => r.url === "/v0.1/publish")).toHaveLength(before);
  });

  test("a version held with other packages is refused", async () => {
    const cwd = member(SERVER());
    held.set("io.github.acme/mcp@1.4.0", JSON.parse(SERVER({ packages: [{ registryType: "npm", identifier: "@acme/other", version: "1.4.0" }] })));
    const t = await make();
    expect((await refused(t.stage(context(cwd, oidcEnv())))).code).toBe("publish-mcp-registry-version-exists");
  });

  test("github-token and registry-token", async () => {
    const cwd = member(SERVER());
    const viaGithub = await make({ auth: "github-token" });
    const a = context(cwd, { MCP_GITHUB_TOKEN: "ghp_good" });
    await viaGithub.reveal(a, await viaGithub.stage(a));
    expect(held.size).toBe(1);
    held.clear();
    const viaRegistry = await make({ auth: "registry-token", tokenEnv: "MY_TOKEN" });
    const b = context(cwd, { MY_TOKEN: "reg-token-xyz" });
    await viaRegistry.reveal(b, await viaRegistry.stage(b));
    expect(held.size).toBe(1);
    expect(requests.filter((r) => r.url.startsWith("/v0.1/auth")).length).toBe(2);
  });

  test("missing credentials are refused in the plan", async () => {
    const cwd = member(SERVER());
    expect((await refused((await make()).plan(context(cwd, {})))).code).toBe("publish-credentials-missing");
    expect((await refused((await make({ auth: "github-token" })).plan(context(cwd, {})))).code).toBe("publish-credentials-missing");
  });

  test("a registry that refuses the exchange or the publish fails with its reason", async () => {
    const cwd = member(SERVER());
    const bad = await make({ auth: "github-token" });
    expect((await refused(bad.stage(context(cwd, { MCP_GITHUB_TOKEN: "ghp_bad" })))).code).toBe("publish-mcp-registry-auth");
    refuse = { status: 400, detail: "namespace not allowed" };
    const t = await make();
    const ctx = context(cwd, oidcEnv());
    const err = await refused(t.reveal(ctx, await t.stage(ctx)));
    expect(err.code).toBe("publish-mcp-registry-failed");
    expect(err.message).toContain("namespace not allowed");
  });

  test("a server.json for another version is refused before anything is sent", async () => {
    const cwd = member(SERVER({ version: "1.3.9" }));
    const t = await make();
    expect((await refused(t.stage(context(cwd, oidcEnv())))).code).toBe("publish-mcp-registry-version-mismatch");
    expect(requests).toHaveLength(0);
  });

  test("server names a path in the member", async () => {
    const cwd = member(SERVER());
    mkdirSync(join(cwd, "mcp"));
    writeFileSync(join(cwd, "mcp/server.json"), SERVER({ version: "1.4.0" }));
    const t = await make({ server: "mcp/server.json" });
    expect((await t.plan(context(cwd, oidcEnv())))[0]!.name).toContain("1.4.0");
  });
});

describe("the reveal order", () => {
  test("a target that reveals last reveals after the targets declared after it", async () => {
    const order: string[] = [];
    const fake = (name: string, revealsLast = false): PublishTarget => ({
      kind: "npm",
      name,
      destination: name,
      credentialEnv: [],
      key: name,
      ...(revealsLast ? { revealsLast } : {}),
      plan: async () => [],
      stage: async () => ({ target: name, destination: name, items: [], state: {} }),
      reveal: async () => {
        order.push(name);
        return { target: name, destination: name, items: [] };
      },
    });
    const cwd = member("{}");
    await runPublish({ cwd, release: context(cwd, {}).release, label: "1.4.0", targets: [fake("registry", true), fake("npm"), fake("oci")], ctx: context(cwd, {}), record: false });
    expect(order).toEqual(["npm", "oci", "registry"]);
  });

  test("the rest first, then the uploads at reveal (pypi, cargo, marketplace), then the targets that reveal last, each in the order declared", async () => {
    const order: string[] = [];
    const fake = (name: string, flag: "uploadsAtReveal" | "revealsLast" | null = null): PublishTarget => ({
      kind: "npm",
      name,
      destination: name,
      credentialEnv: [],
      key: name,
      ...(flag ? { [flag]: true } : {}),
      plan: async () => [],
      stage: async () => ({ target: name, destination: name, items: [], state: {} }),
      reveal: async () => {
        order.push(name);
        return { target: name, destination: name, items: [] };
      },
    });
    const targets = [fake("registry", "revealsLast"), fake("pypi", "uploadsAtReveal"), fake("npm"), fake("cargo", "uploadsAtReveal"), fake("forge")];
    expect(revealOrder(targets).map((t) => t.name)).toEqual(["npm", "forge", "pypi", "cargo", "registry"]);
    const cwd = member("{}");
    await runPublish({ cwd, release: context(cwd, {}).release, label: "1.4.0", targets, ctx: context(cwd, {}), record: false });
    expect(order).toEqual(["npm", "forge", "pypi", "cargo", "registry"]);
  });

  test("#5157: every target stages, then release.verify runs, then the reveals go in that order; verify can't see the registry", async () => {
    const steps: string[] = [];
    const fake = (name: string, flags: Partial<Pick<PublishTarget, "uploadsAtReveal" | "revealsLast">> = {}): PublishTarget => ({
      kind: "npm",
      name,
      destination: name,
      credentialEnv: [],
      key: name,
      ...flags,
      plan: async () => [],
      stage: async () => {
        steps.push(`stage ${name}`);
        return { target: name, destination: name, items: [], state: {} };
      },
      reveal: async () => {
        steps.push(`reveal ${name}`);
        return { target: name, destination: name, items: [] };
      },
    });
    const targets = [fake("registry", { uploadsAtReveal: true, revealsLast: true }), fake("pypi", { uploadsAtReveal: true }), fake("npm")];
    expect(unstagedForVerify(targets)).toEqual(["registry", "pypi"]);
    const runVerify: VerifyRunner = (command) => {
      steps.push(`verify ${command}`);
      return 0;
    };
    const cwd = member("{}");
    const run = await runPublish({ cwd, release: context(cwd, {}).release, label: "1.4.0", targets, ctx: context(cwd, {}), verify: verifySteps(["check"]), runVerify, record: false });
    expect(run.verify).toBe("passed");
    expect(steps).toEqual(["stage registry", "stage pypi", "stage npm", "verify check", "reveal npm", "reveal pypi", "reveal registry"]);
  });
});

describe("chant release doctor", () => {
  const run = async (env: NodeJS.ProcessEnv, decl: Partial<McpRegistryPublishDeclaration> = {}, json = SERVER()) => {
    const cwd = member(json);
    const report = await releaseDoctor({ cwd, publish: [PublishDeclarationSchema.parse({ type: "mcp-registry", registry: base, ...decl })], env, releaseWorkflow: null });
    return report.targets[0]!.checks;
  };
  const status = (checks: Array<{ check: string; status: string }>, name: string) => checks.find((c) => c.check === name)?.status;

  test("in a GitHub job: the namespace, the listing and the OIDC exchange", async () => {
    const checks = await run({ ...oidcEnv(), GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app" });
    expect(status(checks, "mcp-registry-namespace")).toBe("ok");
    expect(status(checks, "mcp-registry-server-listed")).toBe("ok");
    expect(status(checks, "mcp-registry-auth")).toBe("ok");
    expect(requests.some((r) => r.url === "/v0.1/publish")).toBe(false);
  });

  test("a name outside the repository owner's namespace fails", async () => {
    const checks = await run({ ...oidcEnv(), GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "other/app" });
    expect(status(checks, "mcp-registry-namespace")).toBe("fail");
    expect(status(await run({ GITHUB_REPOSITORY: "acme/app" }, {}, SERVER({ name: "com.example/mcp" })), "mcp-registry-namespace")).toBe("fail");
  });

  test("on a workstation the OIDC exchange can't be tried", async () => {
    expect(status(await run({ GITHUB_REPOSITORY: "acme/app" }), "mcp-registry-auth")).toBe("unknown");
  });

  test("a GitHub token is exchanged, a missing one warns on a workstation", async () => {
    expect(status(await run({ MCP_GITHUB_TOKEN: "ghp_good" }, { auth: "github-token" }), "mcp-registry-auth")).toBe("ok");
    expect(status(await run({ MCP_GITHUB_TOKEN: "ghp_bad" }, { auth: "github-token" }), "mcp-registry-auth")).toBe("fail");
    expect(status(await run({}, { auth: "github-token" }), "mcp-registry-token")).toBe("warn");
  });

  test("a missing server.json fails", async () => {
    const cwd = member("{}");
    const report = await releaseDoctor({ cwd, publish: [PublishDeclarationSchema.parse({ type: "mcp-registry", server: "nope.json", registry: base })], env: {}, releaseWorkflow: null });
    expect(report.targets[0]!.checks[0]!.status).toBe("fail");
  });
});
