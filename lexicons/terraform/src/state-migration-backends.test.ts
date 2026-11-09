/**
 * #4806: backend moves planned by the lexicon and run by chant core's gated
 * migration. The binary is faked: `init` records the backend a root's
 * `backend.json` (or the override file) names into the data dir it is
 * given; `state pull` and `state push` read and write that backend: a local
 * file, the in-memory bucket, or an in-memory table for the backends that
 * keep no versions (pg, kubernetes, whose init writes an empty state of its
 * own). `plan` compares the root's `resources.txt` with its state. A TFE
 * workspace is an in-memory API behind the source's fetch. No binary,
 * bucket, service or git is reached.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeLedger } from "@intentius/chant/__fixtures__/gated-ledger";
import { runStateMigration } from "@intentius/chant/state-migration";
import type { BinaryExec, StateFile } from "./state/exec";
import type { StoreFetch } from "./state/object-store";
import { backendBlock, backendMoveProblems, DEFAULT_OVERRIDE_FILE, MigrationError, planTerraformMigration, stateDigest, type BackendMove } from "./state-migration";

type Answer = Awaited<ReturnType<StoreFetch>>;
const answer = (status = 200, body = "", headers: Record<string, string> = {}): Answer => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status < 300, status, text: async () => body, headers: { get: (n: string) => h[n.toLowerCase()] ?? null, forEach: (fn: (v: string, k: string) => void) => Object.entries(h).forEach(([k, v]) => fn(v, k)) } as Answer["headers"] };
};

/** A versioned bucket in memory at http://s3.test, and a TFE API at https://tfe.test with one workspace, acme/legacy. */
function fakeServices() {
  const versions = new Map<string, Array<{ id: string; body: string }>>();
  let n = 0;
  const put = (key: string, body: string) => versions.set(key, [...(versions.get(key) ?? []), { id: `v${++n}`, body }]);
  const latest = (key: string) => versions.get(key)?.at(-1);
  const tfe = { state: "" as string, sv: "sv-1", locked: false, calls: [] as string[] };
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
    if (u.host === "tfe.test") {
      tfe.calls.push(`${init.method ?? "GET"} ${u.pathname}`);
      if (u.pathname === "/.well-known/terraform.json") return answer(200, JSON.stringify({ "tfe.v2": "/api/v2/" }));
      if (u.pathname === "/api/v2/organizations/acme/workspaces/legacy") return answer(200, JSON.stringify({ data: { id: "ws-1" } }));
      if (u.pathname === "/api/v2/workspaces/ws-1/current-state-version") return answer(200, JSON.stringify({ data: { id: tfe.sv, attributes: { "hosted-state-download-url": "/download/state" } } }));
      if (u.pathname === "/download/state") return answer(200, tfe.state);
      if (u.pathname === "/api/v2/workspaces/ws-1/actions/lock") {
        if (tfe.locked) return answer(409);
        tfe.locked = true;
        return answer(200, JSON.stringify({ data: { id: "ws-1" } }));
      }
      if (u.pathname === "/api/v2/workspaces/ws-1/actions/unlock") {
        tfe.locked = false;
        return answer(200, "{}");
      }
      return answer(404);
    }
    const key = decodeURIComponent(u.pathname.slice(1));
    const vid = u.searchParams.get("versionId");
    const all = versions.get(key) ?? [];
    if (init.method === "PUT") {
      if (init.headers["if-none-match"] === "*" && all.length) return answer(412);
      put(key, String(init.body));
      return answer(200);
    }
    if (init.method === "DELETE") {
      versions.delete(key);
      return answer(204);
    }
    const v = vid ? all.find((x) => x.id === vid) : all.at(-1);
    if (!v) return answer(404);
    return answer(200, init.method === "HEAD" ? "" : v.body, { "x-amz-version-id": v.id });
  };
  return { versions, fetch, put, latest, tfe };
}

const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1", TF_TOKEN_tfe_test: "tok" };
const s3Backend = (key: string) => ({ type: "s3", config: { bucket: "acme", key, use_lockfile: true, endpoints: { s3: "http://s3.test" } } });

/** The override file's backend block, read back as the binary would. */
function parseBlock(text: string): { type: string; config: Record<string, unknown> } {
  const type = /backend "([^"]+)"/.exec(text)![1]!;
  const config: Record<string, unknown> = {};
  for (const m of text.matchAll(/^ {4}(\w+) = (.*)$/gm)) {
    try {
      config[m[1]!] = JSON.parse(m[2]!);
    } catch {
      config[m[1]!] = m[2];
    }
  }
  return { type, config };
}

/** The binary, over the fake bucket, local files and the tables of the backends that keep no versions. */
function fakeBinary(svc: ReturnType<typeof fakeServices>) {
  const calls: string[] = [];
  const plans = new Map<string, string[]>();
  const tables = new Map<string, string>();
  const tableKey = (b: { type: string; config: Record<string, unknown> }) => `${b.type}:${String(b.config.conn_str ?? b.config.secret_suffix)}`;
  const backendOf = (env: NodeJS.ProcessEnv) => (JSON.parse(readFileSync(join(env.TF_DATA_DIR!, "terraform.tfstate"), "utf-8")) as { backend: { type: string; config: Record<string, unknown> } }).backend;
  const read = (dir: string, env: NodeJS.ProcessEnv): string => {
    const b = backendOf(env);
    if (b.type === "local") {
      const p = String(b.config.path);
      const at = p.startsWith("/") ? p : join(dir, p);
      return existsSync(at) ? readFileSync(at, "utf-8") : "";
    }
    if (b.type === "s3") return svc.latest(`acme/${b.config.key}`)?.body ?? "";
    return tables.get(tableKey(b)) ?? "";
  };
  const exec: BinaryExec = async (_bin, args, dir, env) => {
    const name = dir.split("/").at(-1)!;
    calls.push(`${name}: ${args.join(" ")}`);
    if (args[0] === "init") {
      const override = join(dir, DEFAULT_OVERRIDE_FILE);
      const backend = existsSync(override) ? parseBlock(readFileSync(override, "utf-8")) : JSON.parse(readFileSync(join(dir, "backend.json"), "utf-8"));
      mkdirSync(env.TF_DATA_DIR!, { recursive: true });
      writeFileSync(join(env.TF_DATA_DIR!, "terraform.tfstate"), JSON.stringify({ version: 3, backend }));
      // A kubernetes backend writes an empty state of its own lineage at init.
      if (backend.type === "kubernetes" && !tables.has(tableKey(backend))) tables.set(tableKey(backend), JSON.stringify({ version: 4, serial: 1, lineage: "k8s-own", outputs: {}, resources: [] }));
      return { code: 0, stdout: "", out: "" };
    }
    if (args[0] === "state" && args[1] === "pull") return { code: 0, stdout: read(dir, env), out: "" };
    if (args[0] === "state" && args[1] === "push") {
      const b = backendOf(env);
      const body = readFileSync(args.at(-1)!, "utf-8");
      if (b.type === "s3") svc.put(`acme/${b.config.key}`, body);
      else {
        const was = tables.get(tableKey(b));
        if (was && (JSON.parse(was) as StateFile).lineage !== (JSON.parse(body) as StateFile).lineage && !args.includes("-force")) return { code: 1, stdout: "", out: "Failed to write state: lineage differs" };
        tables.set(tableKey(b), body);
      }
      return { code: 0, stdout: "", out: "" };
    }
    if (args[0] === "plan") {
      const text = read(dir, env);
      const have = new Set(text ? (JSON.parse(text) as StateFile).resources.map((r) => `${r.type}.${r.name}`) : []);
      const code = new Set(readFileSync(join(dir, "resources.txt"), "utf-8").split("\n").filter(Boolean));
      const changes = [...[...code].filter((a) => !have.has(a)).map((a) => `${a}=create`), ...[...have].filter((a) => !code.has(a)).map((a) => `${a}=delete`)];
      plans.set(args.find((a) => a.startsWith("-out="))!.slice(5), changes);
      return { code: 0, stdout: "", out: changes.length ? `Plan: ${changes.length} to change.` : "No changes." };
    }
    if (args[0] === "show") {
      const changes = plans.get(args.at(-1)!) ?? [];
      return { code: 0, stdout: JSON.stringify({ resource_changes: changes.map((c) => ({ address: c.split("=")[0], change: { actions: [c.split("=")[1]] } })) }), out: "" };
    }
    return { code: 1, stdout: "", out: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls, tables };
}

const resource = (type: string, name: string) => ({ mode: "managed", type, name, provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ attributes: { id: name } }] });
const state = (serial: number, resources: ReturnType<typeof resource>[], lineage = "l-app"): StateFile => ({ version: 4, terraform_version: "1.10.0", serial, lineage, outputs: {}, resources, check_results: null });

/** One root, app, whose code holds the queue and now names `backend`. */
function setup(backend: { type: string; config: Record<string, unknown> } = s3Backend("app.tfstate")) {
  const repo = mkdtempSync(join(tmpdir(), "chant-backend-move-"));
  const svc = fakeServices();
  const dir = join(repo, "app");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "backend.json"), JSON.stringify(backend));
  writeFileSync(join(dir, "resources.txt"), "aws_sqs_queue.jobs");
  writeFileSync(join(dir, "old.tfstate"), JSON.stringify(state(7, [resource("aws_sqs_queue", "jobs")])));
  const bin = fakeBinary(svc);
  const work = mkdtempSync(join(tmpdir(), "chant-backend-move-work-"));
  return { repo, dir, svc, bin, work, roots: [{ root: "app", dir, binary: "tofu", env: ENV }] };
}

const gated = (ledger: ReturnType<typeof fakeLedger>, planned: Awaited<ReturnType<typeof planTerraformMigration>>) => ({ name: "to-s3", by: "ana", roots: planned.roots, engine: planned.engine, words: { op: "tf-migrate" }, rules: { mode: "ledger" as const }, ledger });

const fromLocal: BackendMove[] = [{ root: "app", from: { backend: "local", config: { path: "old.tfstate" } } }];

describe("backend moves", () => {
  test("a state read from the backend it was in is proved, bound with its source, and written to the backend the code names", async () => {
    const { svc, bin, work, roots, repo, dir } = setup();
    const ledger = fakeLedger();
    const planned = await planTerraformMigration({ name: "to-s3", backends: fromLocal, roots, work, repo, exec: bin.exec, fetch: svc.fetch });
    const was = JSON.parse(readFileSync(join(dir, "old.tfstate"), "utf-8")) as StateFile;
    expect(planned.roots).toEqual([expect.objectContaining({ root: "app", location: "s3://acme/app.tfstate", before: { digest: null }, after: { digest: stateDigest(was) }, source: { location: "old.tfstate", digest: stateDigest(was) }, proof: { changes: [], summary: "No changes." } })]);
    expect(existsSync(join(dir, DEFAULT_OVERRIDE_FILE))).toBe(false);
    expect((await runStateMigration(gated(ledger, planned))).status).toBe("waiting");
    ledger.approve("bo");
    const r = await runStateMigration(gated(ledger, planned));
    expect(r).toMatchObject({ status: "applied", exit: 0 });
    expect(JSON.parse(svc.latest("acme/app.tfstate")!.body)).toEqual(was);
    expect(readFileSync(join(dir, "old.tfstate"), "utf-8")).toBe(JSON.stringify(was));
    expect(ledger.details[0]).toMatchObject({ result: "applied", "app.source": "old.tfstate", "app.after": svc.latest("acme/app.tfstate")!.id });
  });

  test("a source written after the plan refuses the write under the lock", async () => {
    const { svc, bin, work, roots, repo, dir } = setup();
    const ledger = fakeLedger();
    ledger.approve("bo");
    const planned = await planTerraformMigration({ name: "to-s3", backends: fromLocal, roots, work, repo, exec: bin.exec, fetch: svc.fetch });
    writeFileSync(join(dir, "old.tfstate"), JSON.stringify(state(8, [resource("aws_sqs_queue", "jobs"), resource("aws_sqs_queue", "more")])));
    const r = await runStateMigration(gated(ledger, planned));
    expect(r).toMatchObject({ status: "moved", exit: 4, result: { moved: ["app"] } });
    expect(svc.latest("acme/app.tfstate")).toBeUndefined();
  });

  test("a workspace's state is read over the TFE API under the workspace's own lock, which is released", async () => {
    const { svc, bin, work, roots, repo } = setup();
    svc.tfe.state = JSON.stringify(state(3, [resource("aws_sqs_queue", "jobs")], "l-tfe"));
    const ledger = fakeLedger();
    ledger.approve("bo");
    const backends: BackendMove[] = [{ root: "app", from: { backend: "remote", config: { hostname: "tfe.test", organization: "acme", workspaces: { name: "legacy" } } } }];
    const planned = await planTerraformMigration({ name: "to-s3", backends, roots, work, repo, exec: bin.exec, fetch: svc.fetch });
    expect(planned.roots[0]!.source).toMatchObject({ location: "remote://tfe.test/acme/legacy", version_id: "sv-1" });
    const r = await runStateMigration(gated(ledger, planned));
    expect(r.status).toBe("applied");
    expect(svc.tfe.calls.filter((c) => c.includes("actions/"))).toEqual(["POST /api/v2/workspaces/ws-1/actions/lock", "POST /api/v2/workspaces/ws-1/actions/unlock"]);
    expect((JSON.parse(svc.latest("acme/app.tfstate")!.body) as StateFile).lineage).toBe("l-tfe");
  });

  test("a workspace another run holds the lock of fails the migration with nothing written", async () => {
    const { svc, bin, work, roots, repo } = setup();
    svc.tfe.state = JSON.stringify(state(3, [resource("aws_sqs_queue", "jobs")], "l-tfe"));
    svc.tfe.locked = true;
    const ledger = fakeLedger();
    ledger.approve("bo");
    const backends: BackendMove[] = [{ root: "app", from: { backend: "cloud", config: { hostname: "tfe.test", organization: "acme", workspaces: { name: "legacy" } } } }];
    const planned = await planTerraformMigration({ name: "to-s3", backends, roots, work, repo, exec: bin.exec, fetch: svc.fetch });
    const r = await runStateMigration(gated(ledger, planned));
    expect(r.status === "failed" && r.error).toMatch(/workspace .*cloud:\/\/tfe.test\/acme\/legacy.* is locked/);
    expect(svc.latest("acme/app.tfstate")).toBeUndefined();
  });

  test("an exported state file moves to a pg backend through the binary, under the backend's own lock", async () => {
    const pg = { type: "pg", config: { conn_str: "postgres://db.test/states" } };
    const { svc, bin, work, roots, repo } = setup(pg);
    writeFileSync(join(repo, "export.json"), JSON.stringify(state(2, [resource("aws_sqs_queue", "jobs")], "l-export")));
    const ledger = fakeLedger();
    ledger.approve("bo");
    const planned = await planTerraformMigration({ name: "to-pg", backends: [{ root: "app", from: { backend: "file", config: { path: "export.json" } } }], roots, work, repo, exec: bin.exec, fetch: svc.fetch });
    expect(planned.roots[0]).toMatchObject({ location: "pg:db.test/states/terraform_remote_state.states", source: { location: "export.json" } });
    const r = await runStateMigration({ ...gated(ledger, planned), name: "to-pg" });
    expect(r.status).toBe("applied");
    const push = bin.calls.find((c) => c.includes("state push"))!;
    expect(push).not.toContain("-lock=false");
    expect(push).not.toContain("-force");
    expect((JSON.parse(bin.tables.get("pg:postgres://db.test/states")!) as StateFile).lineage).toBe("l-export");
  });

  test("a kubernetes backend's empty state from init is replaced with -force; one that holds resources is refused", async () => {
    const k8s = { type: "kubernetes", config: { secret_suffix: "app", namespace: "infra" } };
    const { svc, bin, work, roots, repo } = setup(k8s);
    const ledger = fakeLedger();
    ledger.approve("bo");
    const planned = await planTerraformMigration({ name: "to-k8s", backends: fromLocal, roots, work, repo, exec: bin.exec, fetch: svc.fetch });
    expect(planned.roots[0]!.before.digest).not.toBeNull();
    const r = await runStateMigration({ ...gated(ledger, planned), name: "to-k8s" });
    expect(r.status).toBe("applied");
    expect(bin.calls.find((c) => c.includes("state push"))).toContain("-force");
    await expect(planTerraformMigration({ name: "again", backends: fromLocal, roots, work: mkdtempSync(join(tmpdir(), "w-")), repo, exec: bin.exec, fetch: svc.fetch })).rejects.toThrow(/already holds a state/);
  });

  test("a source the code still names, and a source with no state, are refused at plan", async () => {
    const { svc, bin, work, roots, repo } = setup();
    await expect(planTerraformMigration({ name: "m", backends: [{ root: "app", from: { backend: "s3", config: { bucket: "acme", key: "app.tfstate", use_lockfile: true, endpoints: { s3: "http://s3.test" } } } }], roots, work, repo, exec: bin.exec, fetch: svc.fetch })).rejects.toThrow(/code names the backend it moves from/);
    await expect(planTerraformMigration({ name: "m", backends: [{ root: "app", from: { backend: "local", config: { path: "none.tfstate" } } }], roots, work, repo, exec: bin.exec, fetch: svc.fetch })).rejects.toBeInstanceOf(MigrationError);
  });

  test("backendMoveProblems names a credential in the repo, a root that moves twice and a config that names no state", () => {
    expect(
      backendMoveProblems([
        { root: "a", from: { backend: "pg", config: { conn_str: "postgres://u:secret@db/x" } } },
        { root: "a", from: { backend: "s3", config: { bucket: "b" } } },
        { root: "c", from: { backend: "swift", config: {} } },
      ]),
    ).toEqual([
      "backends[0].from.config.conn_str holds a password, which does not belong in the repo; the job gives it in PGPASSWORD",
      "backends[1]: a moves twice",
      "backends[1].from.config must name the bucket and key of the state",
      expect.stringMatching(/^backends\[2\]\.from\.backend must be s3, gcs, azurerm, local, http, pg, kubernetes, consul, remote, cloud, file$/),
    ]);
  });

  test("backendBlock writes the configuration as HCL", () => {
    expect(backendBlock("s3", { bucket: "b", use_lockfile: true, endpoints: { s3: "http://x" }, skip: null })).toBe('terraform {\n  backend "s3" {\n    bucket = "b"\n    use_lockfile = true\n    endpoints = { s3 = "http://x" }\n  }\n}\n');
  });
});
