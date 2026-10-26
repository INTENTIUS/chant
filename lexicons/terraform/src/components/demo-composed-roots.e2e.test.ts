/**
 * `examples/demo-composed-roots` through the pull-request loop (#4448): both
 * scenarios, each from a fresh base, through `chant components pr-plan`, one
 * approval and `chant components pr-apply`, with `terraform.compose` on.
 *
 * - The edit act (a port changes, an admin port appears): one group of three,
 *   every value known at plan, one approval, pr-apply exits 0.
 * - The create act (a subnet, a worker in it, edge recording the worker's
 *   subnet): the group's plan shows the subnet id as known after apply in app
 *   and edge, one approval, pr-apply exits 0 with no round, and the worker
 *   holds the real subnet id after the apply.
 *
 * Twice: on `tofu` with each root's state on local disk, against a floci at
 * CHANT_FLOCI_ENDPOINT (for example `docker run -d -p 4611:4566 floci/floci`
 * and `CHANT_FLOCI_ENDPOINT=http://localhost:4611`), and on `choudoufu`
 * estates against CHOUDOUFU_EMULATOR_ENDPOINT, as
 * `../compose/estate.choudoufu.e2e.test.ts` is gated. For estates each root
 * gets a `live` block, each variable becomes a read of the same output
 * through `terraform_estate_outputs`, and the components lose their `vars`:
 * an estate's module call takes no inputs (`writeEstateRoot`). Core joins
 * the three into a group by the estate reads `terraform-apply` reports
 * (`groupReads`, #4447).
 *
 * Both need the `aws` CLI to read the emulator after the apply, and the
 * hashicorp/aws provider from the registry (CHANT_OFFLINE skips). Each suite
 * skips with the reason named when something is missing.
 *
 * The choudoufu suite reads:
 *
 * - CHOUDOUFU_BIN: the choudoufu binary to run, a path or a name on PATH.
 *   Unset, it is the `choudoufu` on PATH. When set, the test puts a
 *   `choudoufu` link to it first on its own PATH, so the roots (whose config
 *   says `binary: "choudoufu"`) and the version and commit checks below all
 *   run that binary.
 * - CHOUDOUFU_EMULATOR_ENDPOINT: the AWS emulator the estates apply to and the
 *   `aws` CLI reads back, for example the floci that choudoufu's `just smoke`
 *   brings up (`http://localhost:4566`). Unset, the suite skips.
 * - CHOUDOUFU_REPO: a choudoufu checkout holding both the binary's commit and
 *   choudoufu#2261's fix, so `git merge-base` can tell whether the build
 *   carries it (see CHOUDOUFU_SSM_UPDATE_FIX). Default `../choudoufu` beside
 *   this repo. When it cannot answer, the suite skips and says so.
 *
 * For example, from the chant repo:
 *
 *   CHOUDOUFU_BIN=$HOME/src/choudoufu/bin/choudoufu \
 *   CHOUDOUFU_EMULATOR_ENDPOINT=http://localhost:4566 \
 *   CHOUDOUFU_REPO=$HOME/src/choudoufu \
 *   npx vitest run --project e2e lexicons/terraform/src/components/demo-composed-roots.e2e.test.ts
 */

import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrMember, PrReport } from "@intentius/chant/pr-loop";
import { openScenarioLoop, type ScenarioLoop } from "@intentius/chant-test-utils/pr-loop-harness";
import { terraformPlugin } from "../plugin";
import { isOlderVersion, MIN_CHOUDOUFU_ESTATES_VERSION, parseChoudoufuVersion } from "../op/activities/terraform";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const EXAMPLE = join(REPO, "examples", "demo-composed-roots");
const TIMEOUT = 900_000;

function runs(bin: string, args: string[]): string | undefined {
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** The registry has to answer for the provider download; a DNS answer is enough of a probe. */
async function resolvable(host: string): Promise<boolean> {
  try {
    await Promise.race([lookup(host), new Promise((_r, reject) => setTimeout(() => reject(new Error("dns timeout")), 3000))]);
    return true;
  } catch {
    return false;
  }
}

const offline = process.env.CHANT_OFFLINE ? "CHANT_OFFLINE is set, and the roots download hashicorp/aws" : undefined;
const awsCli = runs("aws", ["--version"]) === undefined ? "the aws CLI is not on PATH" : undefined;
const floci = process.env.CHANT_FLOCI_ENDPOINT?.replace(/\/+$/, "");
const emulator = process.env.CHOUDOUFU_EMULATOR_ENDPOINT?.replace(/\/+$/, "");

/**
 * The choudoufu binary the suite runs: CHOUDOUFU_BIN (a path, or a name on
 * PATH) when set, else `choudoufu` on PATH. A set CHOUDOUFU_BIN is linked as
 * `choudoufu` in a scratch directory put first on this process's PATH, which
 * the harness's commands inherit, so every `choudoufu` the roots run is it.
 * `error` says why a set CHOUDOUFU_BIN cannot be used.
 */
function choudoufuBinary(): { bin?: string; error?: string } {
  const named = process.env.CHOUDOUFU_BIN?.trim();
  if (!named) return { bin: runs("which", ["choudoufu"])?.trim() || undefined };
  const bin = named.includes("/") ? (isAbsolute(named) ? named : resolve(named)) : runs("which", [named])?.trim();
  try {
    if (!bin) throw new Error("not found");
    accessSync(bin, constants.X_OK);
  } catch {
    return { error: `CHOUDOUFU_BIN=${named} is not an executable file` };
  }
  const linkDir = mkdtempSync(join(tmpdir(), "chant-choudoufu-bin-"));
  symlinkSync(bin, join(linkDir, "choudoufu"));
  process.env.PATH = `${linkDir}${delimiter}${process.env.PATH ?? ""}`;
  process.on("exit", () => rmSync(linkDir, { recursive: true, force: true }));
  return { bin };
}

const choudoufu = choudoufuBinary();

const tofuMissing =
  runs("tofu", ["version"]) === undefined
    ? "tofu is not on PATH"
    : !floci
      ? "CHANT_FLOCI_ENDPOINT is not set (for example `docker run -d -p 4611:4566 floci/floci` and CHANT_FLOCI_ENDPOINT=http://localhost:4611)"
      : (awsCli ?? offline ?? ((await resolvable("registry.opentofu.org")) ? undefined : "registry.opentofu.org does not resolve"));

/**
 * The choudoufu commit that fixes an in-place `aws_ssm_parameter` update
 * under a `live` block (choudoufu#2261, chant#4470): before it, the plan
 * carried `insecure_value` as known after apply and the apply sent no
 * `PutParameter`. It is on choudoufu's integration/engine-ship (merge
 * de9bdaa0bb) and in no release yet, so a version floor would refuse every
 * build that has it. The check is the build's commit instead: the
 * `vcs.revision` Go stamps into the binary, which has to descend from this
 * one in a choudoufu checkout (CHOUDOUFU_REPO, or `../choudoufu` beside this
 * repo). When a release carries the fix, a release build at or above it can
 * pass on its version alone.
 */
const CHOUDOUFU_SSM_UPDATE_FIX = "9edd589376223f07642ee6bdf20d31cc56ba76cf";

/** The commit a Go binary was built at, from its embedded build info: `go version -m` when go is on PATH, else the bytes themselves. */
function goBuildRevision(bin: string): string | undefined {
  const rev = /^\s*build\s+vcs\.revision=([0-9a-f]{40})\s*$/m;
  const fromGo = runs("go", ["version", "-m", bin]);
  if (fromGo !== undefined) return rev.exec(fromGo)?.[1];
  try {
    return /\tvcs\.revision=([0-9a-f]{40})\n/.exec(readFileSync(bin).toString("latin1"))?.[1];
  } catch {
    return undefined;
  }
}

/** Why this choudoufu lacks {@link CHOUDOUFU_SSM_UPDATE_FIX}, or cannot be shown to have it. `undefined` when it has it. */
function choudoufuLacksSsmUpdateFix(): string | undefined {
  const bin = choudoufu.bin;
  const rev = bin ? goBuildRevision(bin) : undefined;
  const fix = `choudoufu#2261's fix (${CHOUDOUFU_SSM_UPDATE_FIX.slice(0, 10)})`;
  if (!rev) return `the choudoufu binary names no vcs.revision, so it cannot be shown to carry ${fix}; build it from a git checkout`;
  const repo = process.env.CHOUDOUFU_REPO ?? join(REPO, "..", "choudoufu");
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", CHOUDOUFU_SSM_UPDATE_FIX, rev], { stdio: "ignore" });
    return undefined;
  } catch (e) {
    if ((e as { status?: number }).status === 1) return `choudoufu at ${rev.slice(0, 10)} does not carry ${fix}`;
    return `cannot tell whether choudoufu at ${rev.slice(0, 10)} carries ${fix}: ${repo} is not a choudoufu checkout holding both commits (set CHOUDOUFU_REPO, and fetch)`;
  }
}

const choudoufuOut = choudoufu.bin ? runs(choudoufu.bin, ["version"]) : undefined;
const choudoufuVersion = choudoufuOut === undefined ? undefined : (parseChoudoufuVersion(choudoufuOut) ?? "dev");
const choudoufuMissing =
  choudoufu.error ??
  (choudoufuVersion === undefined
    ? process.env.CHOUDOUFU_BIN
      ? `CHOUDOUFU_BIN=${process.env.CHOUDOUFU_BIN} does not answer \`version\``
      : "choudoufu is not on PATH (or set CHOUDOUFU_BIN)"
    : choudoufuVersion !== "dev" && isOlderVersion(choudoufuVersion, MIN_CHOUDOUFU_ESTATES_VERSION)
      ? `choudoufu ${choudoufuVersion} is older than v${MIN_CHOUDOUFU_ESTATES_VERSION}`
      : (choudoufuLacksSsmUpdateFix() ?? (!emulator
        ? "CHOUDOUFU_EMULATOR_ENDPOINT is not set (bring up choudoufu's `just smoke` emulator stack and export it)"
        : (awsCli ?? offline ?? ((await resolvable("registry.terraform.io")) ? undefined : "registry.terraform.io does not resolve")))));

interface Mode {
  name: "tofu" | "choudoufu";
  missing: string | undefined;
  endpoint: string | undefined;
  estate: boolean;
}

const MODES: Mode[] = [
  { name: "tofu", missing: tofuMissing, endpoint: floci, estate: false },
  { name: "choudoufu", missing: choudoufuMissing, endpoint: emulator, estate: true },
];

/** The root each root's variables read, by root: every variable is that root's output of the same name. */
const UPSTREAM: Record<string, string> = { app: "network", edge: "app" };
const ROOTS = ["network", "app", "edge"];

/** A root's variables of the form the example writes them. */
const VARIABLE = /variable "(\w+)" \{\n  type = string\n\}/g;

/**
 * The root as an estate's: each variable read through `terraform_estate_outputs`
 * of its upstream's estate instead, and no longer declared.
 */
function estateRoot(id: string, root: string, text: string): string {
  const up = UPSTREAM[root];
  if (!up) return text;
  const names = [...text.matchAll(VARIABLE)].map((m) => m[1]!);
  let out = text.replace(new RegExp(`${VARIABLE.source}\\n*`, "g"), "");
  for (const n of names) out = out.replaceAll(`var.${n}`, `data.terraform_estate_outputs.${up}.values.${n}`);
  const list = names.map((n) => `"${n}"`).join(", ");
  return `${out}\ndata "terraform_estate_outputs" "${up}" {\n  estate = "${id}-${up}"\n  names  = [${list}]\n}\n`;
}

/** A component's step `vars`, which an estate's root no longer declares. */
const VARS = /^[ \t]*vars: \{\n[\s\S]*?^[ \t]*\},\n/m;

/** Every copied file with the example's names made this run's own, and for estates the roots, the components and the config rewritten. */
function rewrite(mode: Mode, id: string) {
  return (rel: string, text: string): string => {
    let out = text.replaceAll("chant-compose", id);
    if (mode.estate && rel === "chant.config.ts") out = out.replace('binary: "tofu"', 'binary: "choudoufu"');
    const root = rel.match(/^roots\/(\w+)\/main\.tf$/)?.[1];
    if (mode.estate && root) out = estateRoot(id, root, out);
    if (mode.estate && rel.endsWith(".component.ts")) out = out.replace(VARS, "");
    return out;
  };
}

/**
 * For estates, each root's `live` block, in a file of its own, with one record
 * store for the three. The base applies root by root, so app reads network's
 * outputs from the records network's apply wrote, and an estate reads another's
 * outputs from its own store. The default `local` store is `.tofu-records`
 * beside each root, so the three share an `s3` store instead: a bucket on the
 * emulator, with the versioning and lifecycle rule choudoufu asks of one.
 */
function prepare(mode: Mode, id: string) {
  const bucket = `${id}-records`;
  let made = false;
  return (dir: string): void => {
    if (!mode.estate) return;
    if (!made) {
      // Before the harness sets the run's environment: the credentials are given here.
      const env = { ...process.env, AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test", AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test", AWS_DEFAULT_REGION: "us-east-1" };
      const s3api = (...a: string[]) => execFileSync("aws", ["--endpoint-url", mode.endpoint!, "s3api", ...a, "--bucket", bucket], { env, stdio: "ignore" });
      s3api("create-bucket");
      s3api("put-bucket-versioning", "--versioning-configuration", "Status=Enabled");
      const rule = { Rules: [{ ID: "records", Status: "Enabled", Filter: {}, NoncurrentVersionExpiration: { NoncurrentDays: 30 } }] };
      s3api("put-bucket-lifecycle-configuration", "--lifecycle-configuration", JSON.stringify(rule));
      made = true;
    }
    const store = `    record_store "s3" {\n      bucket = "${bucket}"\n      region = "us-east-1"\n    }\n`;
    for (const r of ROOTS) writeFileSync(join(dir, "roots", r, "live.tf"), `terraform {\n  live {\n    estate = "${id}-${r}"\n${store}  }\n}\n`);
  };
}

function awsJson(endpoint: string, ...args: string[]): unknown {
  return JSON.parse(execFileSync("aws", ["--endpoint-url", endpoint, "--output", "json", ...args], { encoding: "utf8" }));
}

const ssm = (endpoint: string, name: string): string =>
  (awsJson(endpoint, "ssm", "get-parameter", "--name", name) as { Parameter: { Value: string } }).Parameter.Value;

const byComponent = (r: PrReport): Record<string, PrMember> => Object.fromEntries(r.members.map((m) => [m.component, m]));
const counts = (create: number, update: number) => ({ create, update, replace: 0, delete: 0 });

/** What the plan does to a parameter's `insecure_value`: the action, and the attribute's before and after (or that it is unknown). */
function insecureValue(r: PrReport, resource: string): { action: string; before?: unknown; after?: unknown; unknown?: true } | undefined {
  const e = r.changeSet.entries.find((x) => x.address === resource || x.address.endsWith(`.${resource}`));
  if (!e) return undefined;
  const a = e.attributes.find((x) => x.path === "insecure_value");
  return { action: e.action, before: a?.before, after: a?.after, ...(a?.unknown ? { unknown: a.unknown } : {}) };
}

/** Paths a composed run must not leave in the checkout. */
function leftovers(dir: string): string[] {
  const out: string[] = [];
  if (existsSync(join(dir, ".chant-compose"))) out.push(".chant-compose");
  for (const r of ROOTS) for (const f of readdirSync(join(dir, "roots", r))) if (f.endsWith(".tflock") || f.endsWith(".chant-unwritten")) out.push(`roots/${r}/${f}`);
  return out;
}

function actSuite(mode: Mode, scenario: string, tests: (ctx: { loop: () => ScenarioLoop; id: string; endpoint: string }) => void): void {
  describe.skipIf(mode.missing !== undefined)(`demo-composed-roots, ${scenario}, on ${mode.name}${mode.missing ? `: skipped, ${mode.missing}` : ""}`, () => {
    const id = `cc-${mode.name}-${scenario.replace("chant-compose-", "")}-${Date.now().toString(36)}`;
    const endpoint = mode.endpoint!;
    let loop: ScenarioLoop | undefined;

    beforeAll(async () => {
      loop = await openScenarioLoop({
        example: EXAMPLE,
        repo: REPO,
        plugins: [terraformPlugin],
        env: "demo",
        rewrite: rewrite(mode, id),
        prepare: prepare(mode, id),
        processEnv: {
          AWS_ENDPOINT_URL: endpoint,
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
          AWS_REGION: "us-east-1",
          AWS_DEFAULT_REGION: "us-east-1",
        },
      });
      // The base, applied root by root as the demo host applies it (a fan-out never composes).
      expect(await loop.applyBase()).toBe(0);
    }, TIMEOUT);

    afterAll(async () => {
      await loop?.close();
    });

    tests({ loop: () => loop!, id, endpoint });
  });
}

for (const mode of MODES) {
  actSuite(mode, "chant-compose-edit", ({ loop, id, endpoint }) => {
    test("one pr-plan digest over a group of three, every value known at plan", async () => {
      const { code, report: plan } = await loop().open(1, "chant-compose-edit");
      expect(code).toBe(0);
      expect(plan.status).toBe("planned");
      expect([...plan.selection.changed].sort()).toEqual(["app", "edge", "network"]);
      expect(plan.groups).toEqual([expect.objectContaining({ capability: "terraform-apply", components: ["network", "app", "edge"] })]);
      expect(plan.groups![0]!.digest).toEqual(expect.any(String));
      expect(plan.groups![0]!.reads ?? []).toEqual([]);
      expect(plan.fallbacks ?? []).toEqual([]);
      const m = byComponent(plan);
      expect(Object.fromEntries(Object.entries(m).map(([c, x]) => [c, [x.status, x.counts]]))).toEqual({
        network: ["planned", counts(1, 1)],
        app: ["planned", counts(1, 1)],
        edge: ["planned", counts(1, 1)],
      });
      for (const x of Object.values(m)) {
        expect(x.unknownInputs).toBeUndefined();
        for (const r of x.reads ?? []) expect(r.unknown).toBeUndefined();
      }
      // Each port's parameter plans its new value, on estates too (choudoufu#2261, #4470).
      expect(insecureValue(plan, "aws_ssm_parameter.http_proxy_port")).toEqual({ action: "update", before: "8080", after: "8090" });
      expect(insecureValue(plan, "aws_ssm_parameter.listener_port")).toEqual({ action: "update", before: "8080", after: "8090" });
      expect(insecureValue(plan, "aws_ssm_parameter.upstream")).toEqual({ action: "update", before: "http://app:8080", after: "http://app:8090" });
      expect(plan.changeSet.digest).toBe(plan.digest);
      expect(plan.approval).toEqual({ status: "pending" });
      expect(leftovers(loop().dir)).toEqual([]);
    }, TIMEOUT);

    test("one approval, and pr-apply exits 0 with no round: both ports reach all three roots", async () => {
      const plan = loop().report("plan");
      await loop().approve(1, "pr-apply", plan.digest);
      expect(await loop().merge(1)).toBe(0);
      const applied = loop().report("apply");
      expect(applied.digest).toBe(plan.digest);
      expect(applied.status).toBe("applied");
      expect(applied.approval).toEqual({ status: "approved", approvedBy: ["github:alice"] });
      expect(applied.rounds ?? []).toEqual([]);
      expect(applied.groups?.map((g) => g.components)).toEqual([["network", "app", "edge"]]);
      // The report lists members in no set order; the group names the apply order.
      expect(Object.fromEntries(applied.members.map((x) => [x.component, [x.status, x.groupOutcome]]))).toEqual({
        network: ["applied", "applied"],
        app: ["applied", "applied"],
        edge: ["applied", "applied"],
      });
      // The in-place updates reached the emulator: on estates the apply sends PutParameter (choudoufu#2261, #4470).
      expect(ssm(endpoint, `/${id}/http-proxy-port`)).toBe("8090");
      expect(ssm(endpoint, `/${id}/listener-port`)).toBe("8090");
      expect(ssm(endpoint, `/${id}/upstream`)).toBe("http://app:8090");
      expect(ssm(endpoint, `/${id}/admin-upstream`)).toBe("http://app:9000");
      expect(leftovers(loop().dir)).toEqual([]);
    }, TIMEOUT);
  });

  actSuite(mode, "chant-compose-create", ({ loop, id, endpoint }) => {
    test("one pr-plan digest over a group of three, the new subnet id known after apply in app and edge", async () => {
      const { code, report: plan } = await loop().open(1, "chant-compose-create");
      expect(code).toBe(0);
      expect(plan.status).toBe("planned");
      expect(plan.groups).toEqual([expect.objectContaining({ capability: "terraform-apply", components: ["network", "app", "edge"] })]);
      expect(plan.fallbacks ?? []).toEqual([]);
      // What the group's apply computes: the subnet's id, read by app, and the worker's subnet, read by edge.
      const reads = plan.groups![0]!.reads ?? [];
      expect(reads).toHaveLength(2);
      expect(reads).toEqual(
        expect.arrayContaining([
          { component: "app", ref: "network.subnet_b_id" },
          { component: "edge", ref: "app.worker_subnet_id" },
        ]),
      );
      const m = byComponent(plan);
      // A member's reads are its `vars`; an estate's components have none.
      if (!mode.estate) {
        expect(m.app!.reads?.find((r) => r.upstream === "network")?.unknown).toEqual(["subnet_b_id"]);
        expect(m.edge!.reads?.find((r) => r.upstream === "app")?.unknown).toEqual(["worker_subnet_id"]);
      }
      // Inside the group they are no holes, and no member waits on a later round.
      for (const x of Object.values(m)) expect(x.unknownInputs).toBeUndefined();
      for (const member of plan.changeSet.members) expect(member.holes ?? []).toEqual([]);
      // edge's allowlist plans its new value, on estates too (choudoufu#2261, #4470).
      expect(insecureValue(plan, "aws_ssm_parameter.allowlist")).toEqual({ action: "update", before: "10.0.1.0/24", after: "10.0.1.0/24,10.0.2.0/24" });
      expect(Object.fromEntries(Object.entries(m).map(([c, x]) => [c, x.counts]))).toEqual({
        network: counts(1, 0),
        app: counts(1, 0),
        edge: counts(1, 1),
      });
      expect(leftovers(loop().dir)).toEqual([]);
    }, TIMEOUT);

    test("one approval, and pr-apply exits 0 with no round: app's worker and edge hold the real subnet id", async () => {
      const plan = loop().report("plan");
      await loop().approve(1, "pr-apply", plan.digest);
      expect(await loop().merge(1)).toBe(0);
      const applied = loop().report("apply");
      expect(applied.digest).toBe(plan.digest);
      expect(applied.status).toBe("applied");
      expect(applied.rounds ?? []).toEqual([]);
      // The report lists members in no set order; the group names the apply order.
      expect(Object.fromEntries(applied.members.map((x) => [x.component, [x.status, x.groupOutcome]]))).toEqual({
        network: ["applied", "applied"],
        app: ["applied", "applied"],
        edge: ["applied", "applied"],
      });

      const subnets = (awsJson(endpoint, "ec2", "describe-subnets", "--filters", "Name=cidr-block,Values=10.0.2.0/24", `Name=tag:chant:estate,Values=${id}`) as { Subnets: { SubnetId: string }[] }).Subnets;
      expect(subnets).toHaveLength(1);
      const subnetB = subnets[0]!.SubnetId;
      expect(subnetB).toMatch(/^subnet-/);
      const workers = (awsJson(endpoint, "ec2", "describe-network-interfaces", "--filters", `Name=subnet-id,Values=${subnetB}`, `Name=tag:chant:estate,Values=${id}`) as {
        NetworkInterfaces: { SubnetId: string }[];
      }).NetworkInterfaces;
      expect(workers.map((w) => w.SubnetId)).toEqual([subnetB]);
      expect(ssm(endpoint, `/${id}/worker-subnet`)).toBe(subnetB);
      expect(ssm(endpoint, `/${id}/allowlist`)).toBe("10.0.1.0/24,10.0.2.0/24");

      if (!mode.estate) {
        // app's own state holds the id network's state does.
        const state = (r: string) => JSON.parse(readFileSync(join(loop().dir, "roots", r, "terraform.tfstate"), "utf8")) as { resources: { type: string; name: string; instances: { attributes: Record<string, unknown> }[] }[] };
        const attr = (r: string, type: string, name: string, key: string) => state(r).resources.find((x) => x.type === type && x.name === name)!.instances[0]!.attributes[key];
        expect(attr("network", "aws_subnet", "b", "id")).toBe(subnetB);
        expect(attr("app", "aws_network_interface", "worker", "subnet_id")).toBe(subnetB);
      }
      expect(leftovers(loop().dir)).toEqual([]);
    }, TIMEOUT);
  });
}
