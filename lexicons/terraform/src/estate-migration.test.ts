/**
 * #4806: migrations into and between choudoufu estates, planned by the
 * lexicon and run by chant core's gated migration. choudoufu is faked over
 * an in-memory set of live resources, each carrying its estate marker:
 * `plan` of a root destroys each resource its estate holds that its code
 * (`resources.txt`) does not name and creates each one it names that no
 * resource of its estate is; `live-mv` retags; `live-import` ratifies and
 * stamps the resources of a state file. No binary, cloud or git is reached.
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeLedger } from "@intentius/chant/__fixtures__/gated-ledger";
import { runStateMigration } from "@intentius/chant/state-migration";
import { parseRatification, planEstateMigration, PROGRESS_FLAG, stampFailures } from "./estate-migration";
import type { BinaryExec, StateFile } from "./state/exec";
import { MigrationError } from "./state-migration";

/** Live resources by address: the estate whose marker each carries, and its live id. */
function fakeChoudoufu(opts: { progress?: boolean } = {}) {
  const live = new Map<string, { estate: string | undefined; id: string }>();
  const calls: string[] = [];
  const plans = new Map<string, string[]>();
  const estateOf = (dir: string) => readFileSync(join(dir, "estate.txt"), "utf-8").trim();
  const codeOf = (dir: string) => readFileSync(join(dir, "resources.txt"), "utf-8").split("\n").filter(Boolean);
  const exec: BinaryExec = async (_bin, args, dir, _env, io) => {
    const name = dir.split("/").at(-1)!;
    calls.push(`${name}: ${args.join(" ")}`);
    const estate = estateOf(dir);
    if (args[0] === "init") return { code: 0, stdout: "", out: "" };
    if (args[0] === "live-mv" && args[1] === "-help") return { code: 0, stdout: "", out: opts.progress ? `  ${PROGRESS_FLAG}  one line per resource\n` : "" };
    if (args[0] === "live-import" && args[1] === "-help") return { code: 0, stdout: "", out: "" };
    if (args[0] === "plan") {
      const code = new Set(codeOf(dir));
      const mine = [...live].filter(([, v]) => v.estate === estate).map(([a]) => a);
      const changes = [...mine.filter((a) => !code.has(a)).map((a) => `${a}=delete`), ...[...code].filter((a) => live.get(a)?.estate !== estate).map((a) => `${a}=create`)];
      plans.set(args.find((a) => a.startsWith("-out="))!.slice(5), changes);
      return { code: 0, stdout: "", out: changes.length ? `Plan: ${changes.length} to change.` : "No changes." };
    }
    if (args[0] === "show") {
      const changes = plans.get(args.at(-1)!) ?? [];
      return { code: 0, stdout: JSON.stringify({ resource_changes: changes.map((c) => ({ address: c.split("=")[0], change: { actions: [c.split("=")[1]] } })) }), out: "" };
    }
    if (args[0] === "live-mv") {
      const from = args.find((a) => a.startsWith("-from-estate="))!.slice(13);
      const address = args.at(-1)!;
      const r = live.get(address);
      if (!r || r.estate !== from) return { code: 0, stdout: JSON.stringify({ refusal: { summary: "not found", detail: `${address} is not in estate ${from}` } }), out: "" };
      const dry = args.includes("-dry-run");
      if (!dry) {
        r.estate = estate;
        if (args.includes(PROGRESS_FLAG)) io?.stderr?.(JSON.stringify({ address, outcome: "moved" }));
      }
      return { code: 0, stdout: JSON.stringify({ resource: { live_id: r.id }, dry_run: dry, written: !dry }), out: "" };
    }
    if (args[0] === "live-import") {
      const st = JSON.parse(readFileSync(args.find((a) => a.startsWith("-state="))!.slice(7), "utf-8")) as StateFile;
      const rows = st.resources.map((r) => ({ address: `${r.type}.${r.name}`, live: live.get(`${r.type}.${r.name}`) }));
      const verified = rows.filter((r) => r.live);
      const missing = rows.filter((r) => !r.live);
      if (args.includes("-approve")) {
        for (const r of verified) r.live!.estate = estate;
        return { code: 0, stdout: `Stamped ${verified.length}: 0 failed, ${missing.length} skipped.\n`, out: "" };
      }
      const out = [
        `VERIFIED (${verified.length}) - eligible for stamping`,
        ...verified.map((r) => `  ${r.address}  ${r.address.split(".")[0]}  live id: ${r.live!.id}`),
        "",
        ...(missing.length ? [`MISSING (${missing.length}) - not found`, ...missing.map((r) => `  ${r.address}  ${r.address.split(".")[0]}  live id: -`)] : []),
      ].join("\n");
      return { code: 0, stdout: out, out };
    }
    return { code: 1, stdout: "", out: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls, live };
}

function root(repo: string, name: string, estate: string, code: string[]) {
  const dir = join(repo, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "estate.txt"), estate);
  writeFileSync(join(dir, "resources.txt"), code.join("\n"));
  return { root: name, dir, binary: "/usr/local/bin/choudoufu", estate, env: {} };
}

const gated = (ledger: ReturnType<typeof fakeLedger>, planned: Awaited<ReturnType<typeof planEstateMigration>>, name = "retag-queue") => ({ name, by: "ana", roots: planned.roots, engine: planned.engine, words: { op: "tf-migrate" }, rules: { mode: "ledger" as const }, ledger });

describe("planEstateMigration: a retag", () => {
  function setup(progress = false) {
    const repo = mkdtempSync(join(tmpdir(), "chant-estate-"));
    const bin = fakeChoudoufu({ progress });
    bin.live.set("aws_sqs_queue.jobs", { estate: "platform", id: "q-123" });
    bin.live.set("aws_s3_bucket.logs", { estate: "platform", id: "b-1" });
    const roots = [root(repo, "platform", "platform", ["aws_s3_bucket.logs"]), root(repo, "queues", "queues", ["aws_sqs_queue.jobs"])];
    return { repo, bin, roots, work: mkdtempSync(join(tmpdir(), "chant-estate-work-")) };
  }
  const moves = [{ from: "platform", to: "queues", addresses: ["aws_sqs_queue.jobs"] }];

  test("proves the retag with a dry run, waits for an approval, then retags and plans both roots clean", async () => {
    const { bin, roots, work } = setup(true);
    const lines: string[] = [];
    const verified: string[] = [];
    const planned = await planEstateMigration({ name: "retag-queue", moves, roots, work, exec: bin.exec, progress: (l) => (lines.push(l), true), verified: (r) => verified.push(r) });
    expect(planned.retags).toEqual([{ address: "aws_sqs_queue.jobs", from: "platform", to: "queues", from_estate: "platform", to_estate: "queues", live_id: "q-123", followers: [] }]);
    expect(planned.roots.map((r) => [r.root, r.location, r.proof.changes])).toEqual([["platform", "estate platform", []], ["queues", "estate queues", []]]);
    // A joining root is not planned before the retag.
    expect(bin.calls.filter((c) => c.startsWith("queues: plan"))).toEqual([]);
    const ledger = fakeLedger();
    expect((await runStateMigration(gated(ledger, planned))).status).toBe("waiting");
    expect(bin.live.get("aws_sqs_queue.jobs")!.estate).toBe("platform");
    ledger.approve("bo");
    const r = await runStateMigration(gated(ledger, planned));
    expect(r).toMatchObject({ status: "applied", exit: 0 });
    expect(bin.live.get("aws_sqs_queue.jobs")!.estate).toBe("queues");
    expect(lines).toEqual([JSON.stringify({ address: "aws_sqs_queue.jobs", outcome: "moved" })]);
    expect(verified).toEqual(["platform", "queues"]);
  });

  test("a resource the leaving root's plan does not destroy is refused at plan", async () => {
    const { bin, roots, work } = setup();
    await expect(planEstateMigration({ name: "m", moves: [{ from: "platform", to: "queues", addresses: ["aws_s3_bucket.logs"] }], roots, work, exec: bin.exec })).rejects.toThrow(/does not destroy it/);
  });

  test("a binary that is not choudoufu is refused", async () => {
    const { bin, roots, work } = setup();
    await expect(planEstateMigration({ name: "m", moves, roots: roots.map((r) => ({ ...r, binary: "tofu" })), work, exec: bin.exec })).rejects.toBeInstanceOf(MigrationError);
  });
});

describe("planEstateMigration: an adoption", () => {
  function setup() {
    const repo = mkdtempSync(join(tmpdir(), "chant-adopt-"));
    const bin = fakeChoudoufu();
    bin.live.set("aws_sqs_queue.jobs", { estate: undefined, id: "q-9" });
    const r = root(repo, "app", "app", ["aws_sqs_queue.jobs"]);
    writeFileSync(join(r.dir, "old.tfstate"), JSON.stringify({ version: 4, serial: 3, lineage: "l", resources: [{ mode: "managed", type: "aws_sqs_queue", name: "jobs", instances: [] }] }));
    return { bin, roots: [r], dir: r.dir, work: mkdtempSync(join(tmpdir(), "chant-adopt-work-")) };
  }
  const backends = [{ root: "app", from: { backend: "local", config: { path: "old.tfstate" } } }];

  test("ratifies the old state, binds it as the source, stamps under approval and plans clean", async () => {
    const { bin, roots, work } = setup();
    const planned = await planEstateMigration({ name: "adopt-app", backends, roots, work, exec: bin.exec });
    expect(planned.change).toBe("adopt");
    expect(planned.stamps).toEqual([{ root: "app", estate: "app", address: "aws_sqs_queue.jobs", type: "aws_sqs_queue", status: "VERIFIED", live_id: "q-9" }]);
    expect(planned.roots[0]).toMatchObject({ location: "estate app", source: { location: "old.tfstate" }, proof: { changes: [], summary: "live-import: 1 of 1 resource instance verified" } });
    const ledger = fakeLedger();
    ledger.approve("bo");
    const r = await runStateMigration(gated(ledger, planned, "adopt-app"));
    expect(r.status).toBe("applied");
    expect(bin.live.get("aws_sqs_queue.jobs")!.estate).toBe("app");
    expect(ledger.details[0]).toMatchObject({ "app.source": "old.tfstate" });
  });

  test("an old state written after the plan refuses the stamp", async () => {
    const { bin, roots, work, dir } = setup();
    const planned = await planEstateMigration({ name: "adopt-app", backends, roots, work, exec: bin.exec });
    writeFileSync(join(dir, "old.tfstate"), JSON.stringify({ version: 4, serial: 4, lineage: "l", resources: [] }));
    const ledger = fakeLedger();
    ledger.approve("bo");
    const r = await runStateMigration(gated(ledger, planned, "adopt-app"));
    expect(r).toMatchObject({ status: "moved", exit: 4 });
    expect(bin.live.get("aws_sqs_queue.jobs")!.estate).toBeUndefined();
  });

  test("a resource that does not verify fails the proof, and nothing is asked", async () => {
    const { bin, roots, work } = setup();
    bin.live.delete("aws_sqs_queue.jobs");
    const planned = await planEstateMigration({ name: "adopt-app", backends, roots, work, exec: bin.exec });
    const ledger = fakeLedger();
    expect(await runStateMigration(gated(ledger, planned, "adopt-app"))).toMatchObject({ status: "proof-failed", failing: ["app"] });
    expect(ledger.writes).toEqual([]);
  });
});

describe("live-import's reports", () => {
  test("parseRatification and stampFailures read the report and the count line", () => {
    expect(parseRatification("VERIFIED (1) - eligible for stamping\n  a.b  a  live id: x\n\nMISSING (1) - gone\n  c.d  c  live id: -\n")).toEqual([
      { address: "a.b", type: "a", status: "VERIFIED", live_id: "x" },
      { address: "c.d", type: "c", status: "MISSING" },
    ]);
    expect(stampFailures("Stamped 3: 1 failed, 0 skipped.")).toBe(1);
    expect(stampFailures("nothing")).toBeUndefined();
  });
});
