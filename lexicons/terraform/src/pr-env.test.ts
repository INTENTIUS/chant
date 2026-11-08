/**
 * #4762: a pull request's copy of Terraform roots through chant core's
 * prEnvUp and prEnvDown, with the binary faked (it records its arguments and
 * answers a plan with the actions it is told) and the ports in memory. No
 * binary, backend or ledger is reached.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { prEnvDown, prEnvUp, type PrEnvApproval, type PrEnvPorts } from "@intentius/chant/components/pr-env-run";
import type { PrEnvRecord } from "@intentius/chant/components/pr-environment";
import { carriesSuffix, copyBackend, CopyRefusedError, suffixedKey, terraformPrEnvAdapter, terraformPrEnvTeardown, type CopyRoot } from "./pr-env";
import type { BinaryExec } from "./state/exec";

const HEAD = "b".repeat(40);
const tmp = (): string => mkdtempSync(join(tmpdir(), "chant-pr-env-"));

function ports(approval: PrEnvApproval, records: PrEnvRecord[] = []): PrEnvPorts & { records: PrEnvRecord[] } {
  return { records, readRecords: async () => [...records], appendRecord: async (r) => void records.push(r), decideGate: async () => approval };
}

/** The binary: every call recorded with its root's directory; a plan of `actions`, a destroy of one delete. */
function fakeBinary(actions: string[] = ["create"]) {
  const calls: string[] = [];
  const exec: BinaryExec = async (_bin, args, dir) => {
    calls.push(`${dir.split("/").at(-1)}: ${args.join(" ")}`);
    if (args[0] === "show") {
      const destroy = calls.some((c) => c.includes("-destroy") && c.includes(args.at(-1)!));
      const acts = destroy ? ["delete"] : actions;
      return { code: 0, stdout: JSON.stringify({ resource_changes: acts.map((a, i) => ({ address: `null_resource.r${i}`, mode: "managed", type: "null_resource", name: `r${i}`, change: { actions: [a], before: a === "create" ? null : {}, after: a === "delete" ? null : {} } })) }), out: "" };
    }
    return { code: 0, stdout: "", out: args[0] === "plan" ? "Plan: 1 to add, 0 to change, 0 to destroy." : "" };
  };
  return { exec, calls };
}

/** A root directory whose code declares `backend`. */
function rootWith(repo: string, name: string, backend: string): CopyRoot {
  const dir = join(repo, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tf"), `terraform {\n${backend}\n}\n`);
  return { root: name, dir, binary: "terraform", env: {} };
}

describe("a copy's backend", () => {
  test("suffixes a key before .tfstate, a gcs prefix at its end, and a GitLab state's name and lock", () => {
    expect(suffixedKey("envs/dev/terraform.tfstate", "pr-7")).toBe("envs/dev/terraform-pr-7.tfstate");
    expect(suffixedKey("envs/dev/", "pr-7")).toBe("envs/dev-pr-7");
    expect(carriesSuffix("s3://acme/net-pr-7.tfstate", "pr-7")).toBe(true);
    expect(carriesSuffix("s3://acme/net-pr-70.tfstate", "pr-7")).toBe(false);
    const repo = tmp();
    const gcs = rootWith(repo, "net", 'backend "gcs" {\n  bucket = "acme"\n  prefix = "envs/net"\n}');
    expect(copyBackend(gcs.dir, "net", "pr-7")).toEqual({ type: "gcs", attribute: "prefix", key: "envs/net-pr-7", location: "gs://acme/envs/net-pr-7" });
    const a = "https://gitlab.example.com/api/v4/projects/7/terraform/state/net";
    const http = rootWith(repo, "gl", `backend "http" {\n  address = "${a}"\n  lock_address = "${a}/lock"\n}`);
    expect(copyBackend(http.dir, "gl", "pr-7")).toEqual({ type: "http", attribute: "address", key: `${a}-pr-7`, location: `${a}-pr-7`, extra: { lock_address: `${a}-pr-7/lock` } });
  });

  test("refuses a cloud block, a backend with no key attribute, and a block that names no key", () => {
    const repo = tmp();
    expect(() => copyBackend(rootWith(repo, "c", 'cloud {\n  organization = "acme"\n}').dir, "c", "pr-7")).toThrow(CopyRefusedError);
    expect(() => copyBackend(rootWith(repo, "p", 'backend "pg" {\n  conn_str = "x"\n}').dir, "p", "pr-7")).toThrow(/backend is pg/);
    expect(() => copyBackend(rootWith(repo, "s", 'backend "s3" {\n  bucket = "acme"\n}').dir, "s", "pr-7")).toThrow(/names no key/);
  });
});

describe("terraformPrEnvAdapter and terraformPrEnvTeardown", () => {
  const S3 = (key: string) => `backend "s3" {\n  bucket = "acme"\n  key = "${key}"\n  use_lockfile = true\n}`;

  test("each root's copy inits under its suffixed key, waits at the gate, applies its saved plan, and is destroyed in reverse order", async () => {
    const repo = tmp();
    const roots = [rootWith(repo, "network", S3("network.tfstate")), rootWith(repo, "app", S3("app/terraform.tfstate"))];
    const bin = fakeBinary();
    const work = tmp();
    const adapter = () => terraformPrEnvAdapter({ roots: async () => roots, work, exec: bin.exec, lockTimeout: false });
    const waiting = await prEnvUp({ pr: 7, head: HEAD, template: "copy", stack: "product", adapter: adapter(), ports: ports({ status: "pending" }) });
    expect(waiting.exit).toBe(3);
    expect(bin.calls.filter((c) => c.includes("apply"))).toEqual([]);
    const p = ports({ status: "approved", approvedBy: ["bo"] });
    const applied = await prEnvUp({ pr: 7, head: HEAD, template: "copy", stack: "product", adapter: adapter(), ports: p });
    expect(applied.exit).toBe(0);
    expect(bin.calls).toContain("network: init -input=false -no-color -reconfigure -backend-config=key=network-pr-7.tfstate");
    expect(bin.calls).toContain("app: init -input=false -no-color -reconfigure -backend-config=key=app/terraform-pr-7.tfstate");
    expect(bin.calls.filter((c) => c.includes(": apply")).map((c) => c.split(":")[0])).toEqual(["network", "app"]);
    expect(p.records[0]!.locations).toEqual({ network: "s3://acme/network-pr-7.tfstate", app: "s3://acme/app/terraform-pr-7.tfstate" });

    bin.calls.length = 0;
    let done = 0;
    const teardown = terraformPrEnvTeardown({ name: "product", checkout: async () => ({ roots, done: () => void done++ }), work, exec: bin.exec, lockTimeout: false });
    const down = await prEnvDown({ pr: 7, reason: "closed", ports: p, adapters: [teardown], commit: HEAD });
    expect(down.report.status).toBe("destroyed");
    expect(bin.calls.filter((c) => c.includes(": plan")).every((c) => c.includes("-destroy"))).toBe(true);
    expect(bin.calls.filter((c) => c.includes(": apply")).map((c) => c.split(":")[0])).toEqual(["app", "network"]);
    expect(done).toBe(1);
  });

  test("a prepared root plans with no init of its own, and is refused when its recorded key is its own", async () => {
    const repo = tmp();
    const bin = fakeBinary();
    const prepared = (key: string): CopyRoot => ({
      root: "unit",
      dir: join(repo, "unit"),
      binary: "terraform",
      prepare: async () => {
        const dir = join(repo, "unit-cache");
        mkdirSync(join(dir, ".terraform"), { recursive: true });
        writeFileSync(join(dir, ".terraform", "terraform.tfstate"), JSON.stringify({ version: 3, backend: { type: "s3", config: { bucket: "acme", key } } }));
        return { dir, env: {} };
      },
    });
    const ok = terraformPrEnvAdapter({ roots: async () => [prepared("unit/terraform-pr-7.tfstate")], work: tmp(), exec: bin.exec, lockTimeout: false });
    const r = await prEnvUp({ pr: 7, head: HEAD, template: "copy", stack: "product", adapter: ok, ports: ports({ status: "approved" }) });
    expect(r.exit).toBe(0);
    expect(bin.calls.some((c) => c.includes("init"))).toBe(false);
    const own = terraformPrEnvAdapter({ roots: async () => [prepared("unit/terraform.tfstate")], work: tmp(), exec: bin.exec, hint: "make remote_state read the suffix" });
    const refused = await prEnvUp({ pr: 7, head: HEAD, template: "copy", stack: "product", adapter: own, ports: ports({ status: "approved" }) });
    expect(refused.report.status).toBe("plan-failed");
    expect(own.refused).toBeInstanceOf(CopyRefusedError);
    expect(own.refused!.message).toMatch(/root's own state, so its copy is refused; make remote_state read the suffix$/);
  });

  test("a root no copy can be made of refuses the environment, and nothing plans", async () => {
    const repo = tmp();
    const bin = fakeBinary();
    const adapter = terraformPrEnvAdapter({ roots: async () => [rootWith(repo, "c", 'cloud {\n  organization = "acme"\n}')], work: tmp(), exec: bin.exec });
    const r = await prEnvUp({ pr: 7, head: HEAD, template: "copy", stack: "product", adapter, ports: ports({ status: "approved" }) });
    expect(r.report.status).toBe("plan-failed");
    expect(adapter.refused).toBeInstanceOf(CopyRefusedError);
    expect(bin.calls).toEqual([]);
  });
});
