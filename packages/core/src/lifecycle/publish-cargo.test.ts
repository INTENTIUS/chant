/**
 * #5167: the cargo target, against a fake `cargo` that answers `metadata`
 * from a file and records each `publish` in a fake sparse index, and a fake
 * of crates.io's trusted-publishing exchange. The stage publishes nothing;
 * the reveal runs `cargo publish` per crate in dependency order. Nothing
 * reaches a network.
 */

import { afterAll, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { CargoPublishSchema } from "./publish-declaration";
import { cargoAuth, cargoPublishOrder, cargoRegistryTokenVar, sparseIndexPath, type CargoCrate } from "./publish-cargo";
import { createPublishTargets } from "./publish-targets";
import { PublishTargetError, type PublishContext, type StatusContext } from "./release-publish";
import { makeRelease } from "./release-store";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-publish-cargo-"));
  dirs.push(d);
  return d;
};

function context(cwd: string, env: NodeJS.ProcessEnv, extra: Partial<PublishContext> = {}): PublishContext & { lines: string[] } {
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: [], targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "1.2.0", releaseTag: "release/1.2.0", provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), lines, ...extra };
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

const dep = (name: string, req: string, kind: string | null = null, path = true) => ({ name, req, kind, ...(path ? { path: `/ws/${name}` } : {}) });

/** A workspace: cli depends on core and macros, macros on core; tests is not published; core's tests dev-depend on cli with no version. */
const WORKSPACE: CargoCrate[] = [
  { name: "acme-cli", version: "1.2.0", publish: null, dependencies: [dep("acme-core", "^1.2.0"), dep("acme-macros", "^1.2.0"), dep("clap", "^4", null, false)] },
  { name: "acme-core", version: "1.2.0", publish: null, dependencies: [dep("serde", "^1", null, false), dep("acme-cli", "*", "dev")] },
  { name: "acme-macros", version: "1.2.0", publish: null, dependencies: [dep("acme-core", "^1.2.0", "build")] },
  { name: "acme-tests", version: "0.0.0", publish: [], dependencies: [dep("acme-core", "*", "dev")] },
];

/** A fake cargo: metadata from WORKSPACE, publish appends `{ name, version, token }` to the index file unless FAKE_CARGO_FAIL names the crate. */
function fakeCargo(dir: string, workspace = WORKSPACE) {
  const meta = join(dir, "metadata.json");
  const index = join(dir, "index.jsonl");
  const log = join(dir, "cargo.log");
  writeFileSync(meta, JSON.stringify({ packages: workspace, workspace_members: workspace.map((c) => c.name) }));
  const bin = join(dir, "cargo");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, token: process.env.CARGO_REGISTRY_TOKEN || process.env.CARGO_REGISTRIES_ACME_TOKEN || "" }) + "\\n");
if (args[0] === "metadata") { process.stdout.write(fs.readFileSync(${JSON.stringify(meta)}, "utf-8")); process.exit(0); }
if (args[0] === "publish") {
  const name = args[args.indexOf("-p") + 1];
  if (process.env.FAKE_CARGO_FAIL === name) { console.error("error: failed to publish " + name + ": the remote server responded with an error (status 403 Forbidden)"); process.exit(101); }
  const ws = JSON.parse(fs.readFileSync(${JSON.stringify(meta)}, "utf-8")).packages;
  const c = ws.find((p) => p.name === name);
  fs.appendFileSync(${JSON.stringify(index)}, JSON.stringify({ name, vers: c.version, cksum: "ab".repeat(32) }) + "\\n");
  console.error("   Uploading " + name + " v" + c.version + " with " + process.env.CARGO_REGISTRY_TOKEN);
  process.exit(0);
}
if (args[0] === "yank") {
  const name = args[args.length - 1];
  const vers = args[args.indexOf("--version") + 1];
  const undo = args.includes("--undo");
  const lines = fs.readFileSync(${JSON.stringify(index)}, "utf-8").trim().split("\\n").map((l) => JSON.parse(l));
  fs.writeFileSync(${JSON.stringify(index)}, lines.map((l) => JSON.stringify(l.name === name && l.vers === vers ? { ...l, yanked: !undo } : l)).join("\\n") + "\\n");
  process.exit(0);
}
process.exit(2);
`,
  );
  chmodSync(bin, 0o755);
  const published = () => (existsSync(index) ? readFileSync(index, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { name: string; vers: string; cksum: string; yanked?: boolean }) : []);
  const runs = () => readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; token: string });
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  let exchanged = 0;
  let revoked = 0;
  const reply = (status: number, body = "") => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => body });
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => {
    calls.push({ method: init.method, url, headers: init.headers });
    const m = /^https:\/\/(?:index\.crates\.io|cargo\.acme\.test\/index)\/(.+)$/.exec(url);
    if (m && init.method === "GET") {
      const name = m[1]!.split("/").pop()!;
      const lines = published().filter((p) => p.name === name);
      return lines.length ? reply(200, lines.map((l) => JSON.stringify({ name: l.name, vers: l.vers, cksum: l.cksum, deps: [], yanked: l.yanked ?? false })).join("\n")) : reply(404);
    }
    if (url.startsWith("https://gha.test/token")) return new URL(url).searchParams.get("audience") === "crates.io" ? reply(200, JSON.stringify({ value: "gha-id-token-for-crates" })) : reply(400);
    if (url === "https://crates.test/api/v1/trusted_publishing/tokens" && init.method === "POST") {
      const { jwt } = JSON.parse(init.body as string) as { jwt: string };
      if (jwt !== "gha-id-token-for-crates") return reply(400, JSON.stringify({ errors: [{ detail: "No matching Trusted Publishing config found" }] }));
      exchanged++;
      return reply(200, JSON.stringify({ token: "cio-short-lived-token" }));
    }
    if (url === "https://crates.test/api/v1/trusted_publishing/tokens" && init.method === "DELETE") {
      revoked++;
      return reply(204);
    }
    return reply(404);
  };
  return { bin, published, runs, fetch, calls, exchanged: () => exchanged, revoked: () => revoked };
}

function member(): string {
  const dir = temp();
  writeFileSync(join(dir, "Cargo.toml"), "[workspace]\nmembers = [\"crates/*\"]\n");
  return dir;
}

const decl = (d: Record<string, unknown> = {}) => CargoPublishSchema.parse({ type: "cargo", ...d });

describe("cargo (#5167)", () => {
  test("orders the publishable crates after the workspace crates they depend on", () => {
    expect(cargoPublishOrder(WORKSPACE, {}).map((c) => c.name)).toEqual(["acme-core", "acme-macros", "acme-cli"]);
    expect(cargoPublishOrder(WORKSPACE, { crates: ["acme-cli", "acme-core"] }).map((c) => c.name)).toEqual(["acme-core", "acme-cli"]);
    expect(() => cargoPublishOrder(WORKSPACE, { crates: ["acme-tests"] })).toThrow(/publish = \[\]/);
    expect(() => cargoPublishOrder(WORKSPACE, { crates: ["nope"] })).toThrow(/no such crate/);
    const unversioned: CargoCrate[] = [{ ...WORKSPACE[0]!, dependencies: [dep("acme-core", "*")] }, WORKSPACE[1]!];
    expect(() => cargoPublishOrder(unversioned, {})).toThrow(/by path with no version/);
    const cycle: CargoCrate[] = [
      { name: "a", version: "1.0.0", publish: null, dependencies: [dep("b", "^1")] },
      { name: "b", version: "1.0.0", publish: null, dependencies: [dep("a", "^1", "dev")] },
    ];
    expect(() => cargoPublishOrder(cycle, {})).toThrow(/depend on each other/);
    expect(sparseIndexPath("a")).toBe("1/a");
    expect(sparseIndexPath("ab")).toBe("2/ab");
    expect(sparseIndexPath("abc")).toBe("3/a/abc");
    expect(sparseIndexPath("Acme-Core")).toBe("ac/me/acme-core");
    expect(cargoRegistryTokenVar("acme-internal")).toBe("CARGO_REGISTRIES_ACME_INTERNAL_TOKEN");
  });

  test("the stage reads the index and publishes nothing; the reveal publishes in order; a reveal run again publishes nothing", async () => {
    const dir = member();
    const cargo = fakeCargo(temp());
    const [target] = await createPublishTargets([decl()], { fetch: cargo.fetch, cargo: cargo.bin });
    expect(target!.uploadsAtReveal).toBe(true);
    const ctx = context(dir, { CARGO_REGISTRY_TOKEN: "cio-secret-token", PATH: process.env.PATH });
    expect((await target!.plan(ctx)).map((i) => [i.name, i.destination])).toEqual([
      ["acme-core@1.2.0", "https://crates.io/crates/acme-core/1.2.0"],
      ["acme-macros@1.2.0", "https://crates.io/crates/acme-macros/1.2.0"],
      ["acme-cli@1.2.0", "https://crates.io/crates/acme-cli/1.2.0"],
    ]);
    const staged = await target!.stage(ctx);
    expect(cargo.published()).toEqual([]);
    expect(staged.state).toEqual({});

    const done = await target!.reveal(ctx, staged);
    expect(cargo.published().map((p) => p.name)).toEqual(["acme-core", "acme-macros", "acme-cli"]);
    expect(done.items.map((i) => i.digest)).toEqual(Array(3).fill(`sha256:${"ab".repeat(32)}`));
    const publishes = cargo.runs().filter((r) => r.args[0] === "publish");
    expect(publishes[0]!.args).toEqual(["publish", "-p", "acme-core", "--manifest-path", join(dir, "Cargo.toml"), "--no-verify", "--allow-dirty"]);
    expect(publishes.every((r) => r.token === "cio-secret-token")).toBe(true);
    expect(ctx.lines.join("\n")).not.toContain("cio-secret-token");

    await target!.reveal(ctx, staged);
    expect(cargo.runs().filter((r) => r.args[0] === "publish")).toHaveLength(3);
    expect((await target!.stage(ctx)).state).toEqual({ present: "true" });
  });

  test("a yank runs cargo yank for each crate the release published, a restore undoes it, and a run again does nothing (#5163)", async () => {
    const dir = member();
    const cargo = fakeCargo(temp());
    const [target] = await createPublishTargets([decl()], { fetch: cargo.fetch, cargo: cargo.bin });
    const ctx = context(dir, { CARGO_REGISTRY_TOKEN: "cio-secret-token", PATH: process.env.PATH });
    const revealed = (await target!.reveal(ctx, await target!.stage(ctx))).items;
    const status = (s: StatusContext["status"], apply: boolean): StatusContext => ({ ...ctx, status: s, reason: null, replacement: null, revealed, head: null, forgeYank: "prerelease", apply });
    expect((await target!.setStatus!(status("yanked", false))).map((a) => a.what)).toEqual([
      "cargo yank --version 1.2.0 acme-core",
      "cargo yank --version 1.2.0 acme-macros",
      "cargo yank --version 1.2.0 acme-cli",
    ]);
    await target!.setStatus!(status("yanked", true));
    expect(cargo.published().map((p) => p.yanked)).toEqual([true, true, true]);
    expect((await target!.setStatus!(status("yanked", true))).every((a) => a.already)).toBe(true);
    expect((await target!.setStatus!(status("deprecated", true)))[0]!.already).toBe(true);
    expect((await target!.setStatus!(status("active", true)))[0]!.what).toBe("cargo yank --version 1.2.0 --undo acme-core");
    expect(cargo.published().map((p) => p.yanked)).toEqual([false, false, false]);
    expect(cargo.runs().filter((r) => r.args[0] === "yank").every((r) => r.token === "cio-secret-token")).toBe(true);
    expect((await refused(target!.setStatus!({ ...status("yanked", true), env: { PATH: process.env.PATH } }))).code).toBe("publish-credentials-missing");
  });

  test("a failure part way names what was published, and a run again publishes only the rest", async () => {
    const dir = member();
    const cargo = fakeCargo(temp());
    const [target] = await createPublishTargets([decl()], { fetch: cargo.fetch, cargo: cargo.bin });
    const failing = context(dir, { CARGO_REGISTRY_TOKEN: "cio-secret-token", PATH: process.env.PATH, FAKE_CARGO_FAIL: "acme-cli" });
    const staged = await target!.stage(failing);
    const err = await refused(target!.reveal(failing, staged));
    expect(err.code).toBe("publish-cargo-failed");
    expect(err.message).toContain("Published before it: acme-core@1.2.0, acme-macros@1.2.0");
    const ctx = context(dir, { CARGO_REGISTRY_TOKEN: "cio-secret-token", PATH: process.env.PATH });
    const done = await target!.reveal(ctx, staged);
    expect(done.items.map((i) => Boolean(i.present))).toEqual([true, true, false]);
    expect(cargo.published().map((p) => p.name)).toEqual(["acme-core", "acme-macros", "acme-cli"]);
  });

  test("another registry: --registry, its sparse index and the token variable cargo reads for it", async () => {
    const dir = member();
    const cargo = fakeCargo(temp());
    const [target] = await createPublishTargets([decl({ registry: "acme", index: "sparse+https://cargo.acme.test/index/", crates: ["acme-core"] })], { fetch: cargo.fetch, cargo: cargo.bin });
    const ctx = context(dir, { CARGO_REGISTRIES_ACME_TOKEN: "acme-registry-token", PATH: process.env.PATH });
    await target!.reveal(ctx, await target!.stage(ctx));
    const publish = cargo.runs().find((r) => r.args[0] === "publish")!;
    expect(publish.args.slice(-2)).toEqual(["--registry", "acme"]);
    expect(publish.token).toBe("acme-registry-token");
    expect(cargo.calls.some((c) => c.url === "https://cargo.acme.test/index/ac/me/acme-core" && c.headers.authorization === "acme-registry-token")).toBe(true);
  });

  test("trusted publishing: the stage exchanges and revokes; the reveal publishes with a new token and revokes it", async () => {
    const dir = member();
    const cargo = fakeCargo(temp());
    const [target] = await createPublishTargets([decl({ api: "https://crates.test", crates: ["acme-core"] })], { fetch: cargo.fetch, cargo: cargo.bin });
    const env = { PATH: process.env.PATH, GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha.test/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gha-request-token" };
    expect(cargoAuth(decl(), env)).toBe("trusted-publishing");
    expect(cargoAuth(decl(), { ...env, CARGO_REGISTRY_TOKEN: "x" })).toBe("token");
    const ctx = context(dir, env);
    const staged = await target!.stage(ctx);
    expect([cargo.exchanged(), cargo.revoked()]).toEqual([1, 1]);
    await target!.reveal(ctx, staged);
    expect([cargo.exchanged(), cargo.revoked()]).toEqual([2, 2]);
    expect(cargo.runs().find((r) => r.args[0] === "publish")!.token).toBe("cio-short-lived-token");
    expect(ctx.lines.join("\n")).not.toMatch(/cio-short-lived-token|gha-id-token-for-crates/);
  });

  test("refuses a run with no credential, and the supply-chain group without sbom: false", async () => {
    const dir = member();
    const cargo = fakeCargo(temp());
    const [target] = await createPublishTargets([decl()], { fetch: cargo.fetch, cargo: cargo.bin });
    expect((await refused(target!.plan(context(dir, { PATH: process.env.PATH })))).code).toBe("publish-credentials-missing");
    expect((await refused(target!.plan(context(dir, { CARGO_REGISTRY_TOKEN: "t0ken", PATH: process.env.PATH }, { requireSbom: true })))).code).toBe("publish-sbom-missing");
    const [optOut] = await createPublishTargets([decl({ sbom: false })], { fetch: cargo.fetch, cargo: cargo.bin });
    expect(await optOut!.plan(context(dir, { CARGO_REGISTRY_TOKEN: "t0ken", PATH: process.env.PATH }, { requireSbom: true }))).toHaveLength(3);
    const [missingCargo] = await createPublishTargets([decl()], { fetch: cargo.fetch, cargo: join(dir, "no-such-cargo") });
    expect((await refused(missingCargo!.plan(context(dir, { CARGO_REGISTRY_TOKEN: "t0ken" })))).code).toBe("publish-cargo-missing");
  });

  test("the declaration needs an index beside a registry and refuses trusted publishing on one", () => {
    expect(() => decl({ registry: "acme" })).toThrow();
    expect(() => decl({ registry: "acme", index: "https://x.test/", auth: "trusted-publishing" })).toThrow();
    expect(() => decl({ auth: "trusted-publishing", tokenEnv: "X" })).toThrow();
    expect(() => decl({ token: "x" })).toThrow();
  });
});
