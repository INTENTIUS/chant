/**
 * #4762: a migration of resources between Terraform roots, planned by the
 * lexicon and run by chant core's gated migration. The binary is faked: its
 * `init` records the backend a root's `backend.json` (or the proof's
 * override file) names into the data dir it is given, `state pull` and
 * `state push` read and write that backend, and `plan` compares the root's
 * `resources.txt` (its code) with its state. S3 is in memory behind the
 * store's fetch, and the ledger is in memory. No binary, bucket or git is
 * reached.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeLedger } from "@intentius/chant/__fixtures__/gated-ledger";
import { runStateMigration } from "@intentius/chant/state-migration";
import type { BinaryExec, StateFile } from "./state/exec";
import type { StoreFetch } from "./state/object-store";
import { DEFAULT_OVERRIDE_FILE, MigrationError, moveResources, planTerraformMigration, stateDigest } from "./state-migration";

type Answer = Awaited<ReturnType<StoreFetch>>;
const answer = (status = 200, body = "", headers: Record<string, string> = {}): Answer => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status < 300, status, text: async () => body, headers: { get: (n: string) => h[n.toLowerCase()] ?? null, forEach: (fn: (v: string, k: string) => void) => Object.entries(h).forEach(([k, v]) => fn(v, k)) } as Answer["headers"] };
};

/** A versioned bucket in memory, path-style at http://s3.test/<bucket>/<key>, with a PUT only when absent. */
function fakeS3() {
  const versions = new Map<string, Array<{ id: string; body: string }>>();
  let n = 0;
  const put = (key: string, body: string) => versions.set(key, [...(versions.get(key) ?? []), { id: `v${++n}`, body }]);
  const latest = (key: string) => versions.get(key)?.at(-1);
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
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
  return { versions, fetch, put, latest };
}

const S3_ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const s3Backend = (key: string) => ({ type: "s3", config: { bucket: "acme", key, use_lockfile: true, endpoints: { s3: "http://s3.test" } } });

/** The binary, over the fake bucket and local files. */
function fakeBinary(s3: ReturnType<typeof fakeS3>) {
  const calls: string[] = [];
  const plans = new Map<string, string[]>();
  const backendOf = (env: NodeJS.ProcessEnv) => (JSON.parse(readFileSync(join(env.TF_DATA_DIR!, "terraform.tfstate"), "utf-8")) as { backend: { type: string; config: Record<string, unknown> } }).backend;
  const read = (dir: string, env: NodeJS.ProcessEnv): string => {
    const b = backendOf(env);
    if (b.type === "local") return existsSync(String(b.config.path)) ? readFileSync(String(b.config.path), "utf-8") : "";
    return s3.latest(`acme/${b.config.key}`)?.body ?? "";
  };
  const exec: BinaryExec = async (_bin, args, dir, env) => {
    const name = dir.split("/").at(-1)!;
    calls.push(`${name}: ${args.join(" ")}`);
    if (args[0] === "init") {
      const override = join(dir, DEFAULT_OVERRIDE_FILE);
      const backend = existsSync(override) ? { type: "local", config: { path: /path = "(.*)"/.exec(readFileSync(override, "utf-8"))![1] } } : JSON.parse(readFileSync(join(dir, "backend.json"), "utf-8"));
      mkdirSync(env.TF_DATA_DIR!, { recursive: true });
      writeFileSync(join(env.TF_DATA_DIR!, "terraform.tfstate"), JSON.stringify({ version: 3, backend }));
      return { code: 0, stdout: "", out: "" };
    }
    if (args[0] === "state" && args[1] === "pull") return { code: 0, stdout: read(dir, env), out: "" };
    if (args[0] === "state" && args[1] === "push") {
      const b = backendOf(env);
      s3.put(`acme/${b.config.key}`, readFileSync(args.at(-1)!, "utf-8"));
      return { code: 0, stdout: "", out: "" };
    }
    if (args[0] === "plan") {
      const text = read(dir, env);
      const have = new Set(text ? (JSON.parse(text) as StateFile).resources.map((r) => `${r.type}.${r.name}`) : []);
      const code = new Set(readFileSync(join(dir, "resources.txt"), "utf-8").split("\n").filter(Boolean));
      const changes = [...[...code].filter((a) => !have.has(a)).map((a) => `${a}=create`), ...[...have].filter((a) => !code.has(a)).map((a) => `${a}=delete`)];
      plans.set(args.find((a) => a.startsWith("-out="))!.slice(5), changes);
      return { code: 0, stdout: "", out: changes.length ? `Plan: ${changes.length} to change.` : "No changes. Your infrastructure matches the configuration." };
    }
    if (args[0] === "show") {
      const changes = plans.get(args.at(-1)!) ?? [];
      return { code: 0, stdout: JSON.stringify({ resource_changes: changes.map((c) => ({ address: c.split("=")[0], change: { actions: [c.split("=")[1]] } })) }), out: "" };
    }
    return { code: 1, stdout: "", out: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls };
}

const resource = (type: string, name: string) => ({ mode: "managed", type, name, provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ attributes: { id: name } }] });
const state = (serial: number, resources: ReturnType<typeof resource>[], lineage = "l-platform"): StateFile => ({ version: 4, terraform_version: "1.10.0", serial, lineage, outputs: {}, resources, check_results: null });

/** Two roots: platform holds the queue and the bucket, queues holds nothing yet; their code already has the queue in queues. */
function setup(codeMoved = true) {
  const repo = mkdtempSync(join(tmpdir(), "chant-migrate-"));
  const s3 = fakeS3();
  s3.put("acme/platform.tfstate", JSON.stringify(state(4, [resource("aws_sqs_queue", "jobs"), resource("aws_s3_bucket", "logs")])));
  const root = (name: string, resources: string[]) => {
    const dir = join(repo, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "backend.json"), JSON.stringify(s3Backend(`${name}.tfstate`)));
    writeFileSync(join(dir, "resources.txt"), resources.join("\n"));
    return { root: name, dir, binary: "terraform", env: S3_ENV };
  };
  const roots = [root("platform", codeMoved ? ["aws_s3_bucket.logs"] : ["aws_s3_bucket.logs", "aws_sqs_queue.jobs"]), root("queues", codeMoved ? ["aws_sqs_queue.jobs"] : [])];
  const bin = fakeBinary(s3);
  const work = mkdtempSync(join(tmpdir(), "chant-migrate-work-"));
  return { repo, s3, roots, bin, work };
}

const moves = [{ from: "platform", to: "queues", addresses: ["aws_sqs_queue.jobs"] }];

const gated = (ledger: ReturnType<typeof fakeLedger>, planned: Awaited<ReturnType<typeof planTerraformMigration>>) => ({
  name: "move-queues",
  by: "ana",
  roots: planned.roots,
  engine: planned.engine,
  words: { op: "tf-migrate" },
  rules: { mode: "ledger" as const },
  ledger,
});

describe("moveResources", () => {
  test("moves a resource and gives a root with no state a lineage of its own, and names every address that does not fit", () => {
    const before = new Map<string, StateFile | null>([
      ["platform", state(4, [resource("aws_sqs_queue", "jobs")])],
      ["queues", null],
    ]);
    const after = moveResources("m", moves, before);
    expect(after.get("platform")).toMatchObject({ serial: 5, lineage: "l-platform", resources: [] });
    expect(after.get("queues")).toMatchObject({ serial: 1, resources: [{ type: "aws_sqs_queue", name: "jobs" }] });
    expect(moveResources("m", moves, before).get("queues")!.lineage).toBe(after.get("queues")!.lineage);
    expect(() => moveResources("m", [{ from: "platform", to: "queues", addresses: ["aws_sqs_queue.other", "module.gone"] }], before)).toThrow(/aws_sqs_queue.other is not in the state of platform\n {2}module.gone is not in the state of platform/);
  });
});

describe("planTerraformMigration with runStateMigration", () => {
  test("proves both roots clean, waits for an approval, then writes the gaining root first under the locks and checks both", async () => {
    const { s3, roots, bin, work, repo } = setup();
    const ledger = fakeLedger();
    const planned = await planTerraformMigration({ name: "move-queues", moves, roots, work, exec: bin.exec, fetch: s3.fetch, lock: { operation: "product migrate", info: "a state migration is writing this state" } });
    expect(planned.roots.map((r) => [r.root, r.proof.changes])).toEqual([["platform", []], ["queues", []]]);
    expect(planned.roots[0]).toMatchObject({ location: "s3://acme/platform.tfstate", before: { version_id: "v1" } });
    expect(planned.roots[1]!.before).toEqual({ digest: null });
    expect(readdirSync(join(repo, "platform")).sort()).toEqual(["backend.json", "resources.txt"]);

    const first = await runStateMigration(gated(ledger, planned));
    expect(first.status).toBe("waiting");
    expect(s3.versions.get("acme/queues.tfstate")).toBeUndefined();
    ledger.approve("bo");
    const pushesBefore = bin.calls.filter((c) => c.includes("state push")).length;
    const second = await runStateMigration(gated(ledger, planned));
    expect(second).toMatchObject({ status: "applied", exit: 0 });
    const pushes = bin.calls.filter((c) => c.includes("state push")).slice(pushesBefore);
    expect(pushes.map((c) => c.split(":")[0])).toEqual(["queues", "platform"]);
    expect(pushes.every((c) => c.includes("-lock=false"))).toBe(true);
    expect((JSON.parse(s3.latest("acme/queues.tfstate")!.body) as StateFile).resources.map((r) => r.name)).toEqual(["jobs"]);
    expect((JSON.parse(s3.latest("acme/platform.tfstate")!.body) as StateFile).resources.map((r) => r.name)).toEqual(["logs"]);
    expect(s3.versions.has("acme/platform.tfstate.tflock")).toBe(false);
    const [p, q] = [s3.latest("acme/platform.tfstate")!.id, s3.latest("acme/queues.tfstate")!.id];
    expect(second.status === "applied" && second.result.roots.map((r) => [r.root, r.before.version_id, r.after.version_id])).toEqual([
      ["platform", "v1", p],
      ["queues", undefined, q],
    ]);
    expect(ledger.details[0]).toMatchObject({ result: "applied", "platform.before": "v1", "platform.after": p, "queues.after": q });
  });

  test("a root whose code was not moved fails the proof, and nothing is asked", async () => {
    const { s3, roots, bin, work } = setup(false);
    const ledger = fakeLedger();
    const planned = await planTerraformMigration({ name: "move-queues", moves, roots, work, exec: bin.exec, fetch: s3.fetch });
    const r = await runStateMigration(gated(ledger, planned));
    expect(r).toMatchObject({ status: "proof-failed", failing: ["platform", "queues"] });
    expect(ledger.writes).toEqual([]);
  });

  test("a state written after the plan refuses the write under the lock", async () => {
    const { s3, roots, bin, work } = setup();
    const ledger = fakeLedger();
    ledger.approve("bo");
    const planned = await planTerraformMigration({ name: "move-queues", moves, roots, work, exec: bin.exec, fetch: s3.fetch });
    s3.put("acme/platform.tfstate", JSON.stringify(state(5, [resource("aws_sqs_queue", "jobs"), resource("aws_s3_bucket", "logs"), resource("aws_s3_bucket", "more")])));
    const r = await runStateMigration(gated(ledger, planned));
    expect(r).toMatchObject({ status: "moved", exit: 4 });
    expect(bin.calls.some((c) => c.includes("state push"))).toBe(false);
    expect(s3.versions.has("acme/platform.tfstate.tflock")).toBe(false);
  });

  test("a state another run holds the lock of fails the migration with nothing written", async () => {
    const { s3, roots, bin, work } = setup();
    const ledger = fakeLedger();
    ledger.approve("bo");
    const planned = await planTerraformMigration({ name: "move-queues", moves, roots, work, exec: bin.exec, fetch: s3.fetch });
    s3.put("acme/queues.tfstate.tflock", JSON.stringify({ ID: "other", Who: "runner@ci" }));
    const r = await runStateMigration(gated(ledger, planned));
    expect(r).toMatchObject({ status: "failed" });
    expect(r.status === "failed" && r.error).toMatch(/queues: its state is locked .* by runner@ci/);
    expect(bin.calls.some((c) => c.includes("state push"))).toBe(false);
    expect(s3.versions.has("acme/platform.tfstate.tflock")).toBe(false);
  });

  test("a revert puts back the version a migration recorded, and is refused once the state moved past it", async () => {
    const { s3, roots, bin, work } = setup();
    const was = s3.latest("acme/platform.tfstate")!.body;
    s3.put("acme/platform.tfstate", JSON.stringify(state(5, [resource("aws_s3_bucket", "logs")])));
    const restores = [{ root: "platform", location: "s3://acme/platform.tfstate", version_id: "v1", from_version_id: "v2" }];
    const ledger = fakeLedger();
    ledger.approve("bo");
    const back = roots.map((r) => (r.root === "platform" ? { ...r } : r));
    writeFileSync(join(back[0]!.dir, "resources.txt"), "aws_s3_bucket.logs\naws_sqs_queue.jobs");
    const planned = await planTerraformMigration({ name: "move-queues-revert", restores, roots: back, work, exec: bin.exec, fetch: s3.fetch });
    expect(planned.roots).toHaveLength(1);
    const r = await runStateMigration({ ...gated(ledger, planned), name: "move-queues-revert" });
    expect(r.status).toBe("applied");
    const now = JSON.parse(s3.latest("acme/platform.tfstate")!.body) as StateFile;
    expect(now.resources.map((x) => x.name).sort()).toEqual(["jobs", "logs"]);
    expect(now.serial).toBe(6);
    expect(stateDigest({ ...now, serial: 4 })).toBe(stateDigest(JSON.parse(was) as StateFile));
    await expect(planTerraformMigration({ name: "again", restores, roots: back, work: mkdtempSync(join(tmpdir(), "w-")), exec: bin.exec, fetch: s3.fetch })).rejects.toThrow(/moved since/);
  });

  test("an address in no state is refused at plan", async () => {
    const { s3, roots, bin, work } = setup();
    await expect(planTerraformMigration({ name: "m", moves: [{ from: "queues", to: "platform", addresses: ["aws_sqs_queue.jobs"] }], roots, work, exec: bin.exec, fetch: s3.fetch })).rejects.toBeInstanceOf(MigrationError);
  });
});
