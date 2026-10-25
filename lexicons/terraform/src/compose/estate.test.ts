/**
 * The composed run of choudoufu estates (#4445), against a fake choudoufu:
 * three estates (network, app, edge, as in the Terragrunt demo), where app
 * reads the subnet id network creates through `terraform_estate_outputs`.
 * The fake reads the composed root `.chant-compose/main.tf` and each estate
 * directory it calls, so the plan's `provider_config` carries the role each
 * estate's own provider block names. The real binary is
 * `estate.choudoufu.e2e.test.ts`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { compositionFor, type Composition } from "../compose";
import type { TerraformConfig } from "../config";
import type { BinaryExec, Ran } from "../state/exec";
import { estateOutcomes, estateVersionFallback, EstateRun, readEstateApplyText } from "./estate";
import { COMPOSE_DIR } from "./root";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const live = (estate: string, role: string, body: string): string =>
  `terraform {\n  live {\n    estate = "${estate}"\n  }\n}\n\nprovider "aws" {\n  region = "us-east-1"\n  assume_role {\n    role_arn = "${role}"\n  }\n}\n\n${body}`;

const ROLE = (name: string): string => `arn:aws:iam::111111111111:role/${name}`;

function project(roles: { network: string; app: string; edge: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-compose-estate-"));
  made.push(dir);
  const files: Record<string, string> = {
    "roots/network/main.tf": live(
      "network",
      roles.network,
      'resource "aws_subnet" "a" {\n  vpc_id     = "vpc-1"\n  cidr_block = "10.0.1.0/24"\n}\n\noutput "subnet_id" {\n  value = aws_subnet.a.id\n}\n',
    ),
    "roots/app/main.tf": live(
      "app",
      roles.app,
      'data "terraform_estate_outputs" "network" {\n  estate = "network"\n}\n\nresource "aws_instance" "web" {\n  ami       = "ami-1"\n  subnet_id = data.terraform_estate_outputs.network.values.subnet_id\n}\n\noutput "instance_id" {\n  value = aws_instance.web.id\n}\n',
    ),
    "roots/edge/main.tf": live("edge", roles.edge, 'resource "aws_route53_record" "www" {\n  name = "www"\n}\n\noutput "fqdn" {\n  value = aws_route53_record.www.name\n}\n'),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const tf = (name: string): DriverComponent => ({ name, deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }] });
const terraform: TerraformConfig = { binary: "choudoufu", roots: { network: { dir: "roots/network" }, app: { dir: "roots/app" }, edge: { dir: "roots/edge" } }, compose: { enabled: true } };

function composition(dir: string): Composition {
  const c = compositionFor({ projectRoot: dir, components: [tf("network"), tf("app"), tf("edge")], terraform, env: {} });
  expect(c.fallback).toBeUndefined();
  expect(c.estate).toBe(true);
  expect(c.members).toEqual(["app", "edge", "network"]);
  return c;
}

const SUBNET = "subnet-0abc123";

const rc = (module: string, type: string, name: string, actions: string[], after: Record<string, unknown>, afterUnknown: Record<string, unknown>) => ({
  address: `module.${module}.${type}.${name}`,
  module_address: `module.${module}`,
  mode: "managed",
  type,
  name,
  provider_name: "registry.terraform.io/hashicorp/aws",
  change: { actions, before: null, after, after_unknown: afterUnknown, before_sensitive: false, after_sensitive: {} },
});

/** The role each module's provider block names, read from the directory the composed root calls. */
function rolesCalled(composeDir: string): Map<string, string> {
  const main = readFileSync(join(composeDir, "main.tf"), "utf-8");
  // The composed root holds module calls and outputs only: no provider, so no role of its own.
  expect(main).not.toMatch(/\bprovider\s+"/);
  const out = new Map<string, string>();
  for (const m of main.matchAll(/module "([^"]+)" \{\n  source = "([^"]+)"\n\}/g)) {
    const text = readFileSync(join(resolve(composeDir, m[2]!), "main.tf"), "utf-8");
    out.set(m[1]!, text.match(/role_arn = "([^"]+)"/)![1]!);
  }
  return out;
}

function providerConfig(roles: Map<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    [...roles].map(([m, role]) => [`module.${m}:aws`, { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", module_address: `module.${m}`, expressions: { assume_role: [{ role_arn: { constant_value: role } }] } }]),
  );
}

/** The composed plan before the apply: the subnet id, and so app's input, known only after apply. */
function planBefore(roles: Map<string, string>): unknown {
  return {
    format_version: "1.2",
    resource_changes: [
      rc("app", "aws_instance", "web", ["create"], { ami: "ami-1" }, { id: true, subnet_id: true }),
      rc("edge", "aws_route53_record", "www", ["create"], { name: "www" }, { id: true }),
      rc("network", "aws_subnet", "a", ["create"], { vpc_id: "vpc-1", cidr_block: "10.0.1.0/24" }, { id: true }),
    ],
    output_changes: {
      app__instance_id: { actions: ["create"], before: null, after_unknown: true },
      edge__fqdn: { actions: ["create"], before: null, after: "www", after_unknown: false },
      network__subnet_id: { actions: ["create"], before: null, after_unknown: true },
    },
    planned_values: { outputs: { edge__fqdn: { value: "www", sensitive: false } }, root_module: {} },
    prior_state: { format_version: "1.0", values: { outputs: {}, root_module: {} } },
    configuration: { provider_config: providerConfig(roles), root_module: { module_calls: {} } },
  };
}

const res = (module: string, type: string, name: string, values: Record<string, unknown>) => ({
  address: `module.${module}.${type}.${name}`,
  mode: "managed",
  type,
  name,
  provider_name: "registry.terraform.io/hashicorp/aws",
  values,
  sensitive_values: {},
});

/** The composed plan after the apply: `prior_state` holds what each estate's records and the live system say. */
function planAfter(appFailed: boolean): unknown {
  const child = (module: string, resources: unknown[]) => ({ address: `module.${module}`, resources });
  return {
    format_version: "1.2",
    resource_changes: appFailed ? [rc("app", "aws_instance", "web", ["create"], { ami: "ami-1", subnet_id: SUBNET }, { id: true })] : [],
    output_changes: {},
    planned_values: { outputs: {}, root_module: {} },
    prior_state: {
      format_version: "1.0",
      values: {
        outputs: {
          network__subnet_id: { value: SUBNET, sensitive: false },
          edge__fqdn: { value: "www", sensitive: false },
          ...(appFailed ? {} : { app__instance_id: { value: "i-0web", sensitive: false } }),
        },
        root_module: {
          child_modules: [
            ...(appFailed ? [] : [child("app", [res("app", "aws_instance", "web", { id: "i-0web", ami: "ami-1", subnet_id: SUBNET })])]),
            child("edge", [res("edge", "aws_route53_record", "www", { id: "Z1_www", name: "www" })]),
            child("network", [res("network", "aws_subnet", "a", { id: SUBNET, vpc_id: "vpc-1", cidr_block: "10.0.1.0/24" })]),
          ],
        },
      },
    },
  };
}

interface Call {
  args: string[];
  dir: string;
  env: NodeJS.ProcessEnv;
}

interface Fake {
  exec: BinaryExec;
  calls: Call[];
  /** The role each module's provider block named, per plan. */
  roles: Map<string, string>[];
}

function fakeChoudoufu(o: { version?: string; appFails?: boolean } = {}): Fake {
  const calls: Call[] = [];
  const roles: Map<string, string>[] = [];
  let applied = false;
  const ran = (stdout: string, code = 0): Ran => ({ code, stdout, out: stdout });
  const exec: BinaryExec = async (_binary, args, dir, env) => {
    calls.push({ args, dir, env });
    const [cmd] = args;
    if (cmd === "version") return ran(`choudoufu v${o.version ?? "0.31.0"} (based on OpenTofu v1.11.0)\non darwin_arm64\n`);
    if (cmd === "init") return ran("Initialized.\n");
    if (cmd === "plan") {
      const out = args.find((a) => a.startsWith("-out="))!.slice("-out=".length);
      roles.push(rolesCalled(dir));
      writeFileSync(out, applied ? "after" : "before");
      return ran(applied ? (o.appFails ? "Plan: 1 to add, 0 to change, 0 to destroy.\n" : "No changes.\n") : "Plan: 3 to add, 0 to change, 0 to destroy.\n");
    }
    if (cmd === "show") {
      const file = args[args.length - 1]!;
      const which = readFileSync(file, "utf-8");
      if (args.includes("-json")) return ran(JSON.stringify(which === "before" ? planBefore(roles[roles.length - 1]!) : planAfter(!!o.appFails)));
      return ran(
        '  # module.network.aws_subnet.a will be created\n  + resource "aws_subnet" "a" {\n    }\n\n  # module.app.aws_instance.web will be created\n  + resource "aws_instance" "web" {\n    }\n\nPlan: 3 to add, 0 to change, 0 to destroy.\n',
      );
    }
    if (cmd === "apply") {
      applied = true;
      if (o.appFails) {
        return ran(
          [
            "module.network.aws_subnet.a: Creating...",
            "module.edge.aws_route53_record.www: Creating...",
            `module.network.aws_subnet.a: Creation complete after 1s [id=${SUBNET}]`,
            "module.edge.aws_route53_record.www: Creation complete after 1s [id=Z1_www]",
            "module.app.aws_instance.web: Creating...",
            "╷",
            "│ Error: creating EC2 Instance: InvalidAMIID.NotFound",
            "│ ",
            "│   with module.app.aws_instance.web,",
            '│   on ../roots/app/main.tf line 18, in resource "aws_instance" "web":',
            "╵",
          ].join("\n") + "\n",
          1,
        );
      }
      return ran(
        [
          "module.network.aws_subnet.a: Creating...",
          `module.network.aws_subnet.a: Creation complete after 1s [id=${SUBNET}]`,
          "module.edge.aws_route53_record.www: Creation complete after 1s [id=Z1_www]",
          "module.app.aws_instance.web: Creation complete after 9s [id=i-0web]",
          "Apply complete! Resources: 3 added, 0 changed, 0 destroyed.",
        ].join("\n") + "\n",
      );
    }
    throw new Error(`the fake choudoufu was asked for ${args.join(" ")}`);
  };
  return { exec, calls, roles };
}

const JOB_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin", AWS_PROFILE: "ci-job", TF_CLI_ARGS_plan: "-var-file=x.tfvars -parallelism=4" };

function run(dir: string, fake: Fake): EstateRun {
  return new EstateRun({ projectRoot: dir, composition: composition(dir), terraform, env: JOB_ENV, exec: fake.exec, work: mkdtempSync(join(tmpdir(), "chant-compose-estate-work-")) });
}

const ROLES = { network: ROLE("network"), app: ROLE("app"), edge: ROLE("edge") };

describe("EstateRun", () => {
  test("one plan covers all three estates with app's input known after apply, and one apply passes the subnet id to app", async () => {
    const dir = project(ROLES);
    const fake = fakeChoudoufu();
    const r = run(dir, fake);
    try {
      const p = await r.plan();
      expect(p.fallback).toBeUndefined();
      expect(p.error).toBeUndefined();
      expect(Object.keys(p.members).sort()).toEqual(["app", "edge", "network"]);
      expect(p.members.app!.shape.unknownInputs).toEqual(["network.subnet_id"]);
      expect(p.members.app!.reads).toEqual([{ upstream: "network", via: "estate-outputs", name: "network", outputs: ["subnet_id"], unknown: ["subnet_id"] }]);
      expect(p.members.network!.shape.unknownInputs).toEqual([]);
      expect(p.members.network!.changeSet.member.planner).toBe("choudoufu");
      expect(p.digest).not.toBe("");
      // The composed root is gone once the plan is read.
      expect(() => readFileSync(join(dir, COMPOSE_DIR, "main.tf"))).toThrow();

      const a = await r.apply();
      expect(a.ok).toBe(true);
      expect(a.members.network).toMatchObject({ status: "applied", done: 1, planned: 1, outputs: { subnet_id: SUBNET } });
      expect(a.members.app).toMatchObject({ status: "applied", done: 1, outputs: { instance_id: "i-0web" } });
      expect(a.members.edge).toMatchObject({ status: "applied", outputs: { fqdn: "www" } });
      // The subnet network created is the one app's instance was given, in the same apply.
      expect(a.members.app!.resources!.get("aws_instance.web")!.values.subnet_id).toBe(a.members.network!.outputs!.subnet_id);

      const binaryRuns = fake.calls.map((c) => c.args[0]);
      expect(binaryRuns).toEqual(["version", "init", "plan", "show", "show", "apply", "plan", "show"]);
      // Every plan and the one apply run from the composed root.
      for (const c of fake.calls.filter((x) => ["plan", "apply", "init"].includes(x.args[0]!))) expect(c.dir).toBe(join(dir, COMPOSE_DIR));
      expect(fake.calls.filter((c) => c.args[0] === "apply")).toHaveLength(1);
      expect(fake.calls.find((c) => c.args[0] === "apply")!.args).toContain(p.planFile);
    } finally {
      await r.release();
    }
  });

  test("no state pull, state push or lock call is made", async () => {
    const dir = project(ROLES);
    const fake = fakeChoudoufu();
    const r = run(dir, fake);
    try {
      await r.plan();
      await r.apply();
    } finally {
      await r.release();
    }
    for (const c of fake.calls) {
      expect(c.args[0]).not.toBe("state");
      expect(c.args[0]).not.toBe("force-unlock");
      expect(c.args.join(" ")).not.toMatch(/\bstate (pull|push)\b|-lock(=|-timeout)/);
    }
    // No state file is written beside the composed root or in an estate.
    expect(() => readFileSync(join(dir, COMPOSE_DIR, "terraform.tfstate"))).toThrow();
  });

  test("each member's applied values come from the post-apply plan's prior_state, and no bare show is run", async () => {
    const dir = project(ROLES);
    const fake = fakeChoudoufu();
    const r = run(dir, fake);
    try {
      const p = await r.plan();
      const a = await r.apply();
      // Unknown at plan, read from prior_state after.
      expect(p.members.network!.outputs.unknown).toEqual(["subnet_id"]);
      expect(a.members.network!.resources!.get("aws_subnet.a")!.values.id).toBe(SUBNET);
      expect(a.members.app!.resources!.get("aws_instance.web")!.values).toEqual({ id: "i-0web", ami: "ami-1", subnet_id: SUBNET });
      expect((a.after as { prior_state: unknown }).prior_state).toBeDefined();
      // A second plan from the composed root after the apply; every show names a plan file.
      const shows = fake.calls.filter((c) => c.args[0] === "show");
      expect(shows.length).toBeGreaterThan(0);
      for (const s of shows) expect(s.args[s.args.length - 1]).toMatch(/\.tfplan$/);
      const plans = fake.calls.filter((c) => c.args[0] === "plan");
      expect(plans).toHaveLength(2);
      expect(plans[1]!.args.find((x) => x.startsWith("-out="))).toMatch(/composed-after\.tfplan$/);
    } finally {
      await r.release();
    }
  });

  test("two estates under different roles compose, each provider block's role used, and the run adds no role of its own", async () => {
    const dir = project({ network: ROLE("network-admin"), app: ROLE("app-deployer"), edge: ROLE("app-deployer") });
    const fake = fakeChoudoufu();
    const r = run(dir, fake);
    try {
      const p = await r.plan();
      expect(p.error).toBeUndefined();
      // What the binary was called with: each module's own provider block.
      expect(Object.fromEntries(fake.roles[0]!)).toEqual({ network: ROLE("network-admin"), app: ROLE("app-deployer"), edge: ROLE("app-deployer") });
      // Each member's part of the plan names its own role.
      const roleOf = (m: string): unknown =>
        ((p.members[m]!.slice as { configuration: { provider_config: Record<string, { expressions: { assume_role: { role_arn: { constant_value: string } }[] } }> } }).configuration.provider_config.aws!.expressions
          .assume_role[0]!.role_arn.constant_value);
      expect(roleOf("network")).toBe(ROLE("network-admin"));
      expect(roleOf("app")).toBe(ROLE("app-deployer"));
      // The job's environment, its -var-file taken out, and nothing assumed for the run.
      for (const c of fake.calls.filter((x) => x.args[0] !== "version")) {
        expect(c.env.AWS_PROFILE).toBe("ci-job");
        expect(c.env.TF_CLI_ARGS_plan).toBe("-parallelism=4");
        expect(Object.keys(c.env).filter((k) => /ROLE|WEB_IDENTITY|SESSION_TOKEN/.test(k))).toEqual([]);
      }
    } finally {
      await r.release();
    }
  });

  test("a failure in app leaves network applied, and the result says so per member", async () => {
    const dir = project(ROLES);
    const fake = fakeChoudoufu({ appFails: true });
    const r = run(dir, fake);
    try {
      await r.plan();
      const a = await r.apply();
      expect(a.ok).toBe(false);
      expect(a.members.network).toMatchObject({ status: "applied", done: 1, planned: 1, outputs: { subnet_id: SUBNET } });
      expect(a.members.edge).toMatchObject({ status: "applied", done: 1 });
      expect(a.members.app).toMatchObject({ status: "failed", done: 0, planned: 1 });
      expect(a.members.app!.error).toMatch(/^aws_instance\.web: Error: creating EC2 Instance/);
      expect(a.members.app!.outputs).toBeUndefined();
      expect(a.error).toMatch(/creating EC2 Instance/);
    } finally {
      await r.release();
    }
  });

  test("a choudoufu below the minimum version gives a fallback reason, not a failed plan", async () => {
    const dir = project(ROLES);
    const fake = fakeChoudoufu({ version: "0.30.0" });
    const r = run(dir, fake);
    try {
      const p = await r.plan();
      expect(p.error).toBeUndefined();
      expect(p.fallback).toEqual({ kind: "binary", reason: expect.stringMatching(/^choudoufu 0\.30\.0 is older than v0\.31\.0/) });
      expect(p.members).toEqual({});
      expect(fake.calls.map((c) => c.args[0])).toEqual(["version"]);
      const a = await r.apply();
      expect(a.members.network!.status).toBe("not-started");
    } finally {
      await r.release();
    }
  });
});

describe("estate outcomes", () => {
  test("a dev build passes the version check, a release below the floor falls back", () => {
    expect(estateVersionFallback("OpenTofu v1.11.0-dev\non darwin_arm64\n")).toBeUndefined();
    expect(estateVersionFallback("choudoufu v0.31.0 (based on OpenTofu v1.11.0)\n")).toBeUndefined();
    expect(estateVersionFallback("choudoufu v0.29.1 (based on OpenTofu v1.11.0)\n")?.kind).toBe("binary");
  });

  test("the text of an apply names each module's completions, starts and errors", () => {
    const ev = readEstateApplyText(
      "module.network.aws_subnet.a: Creating...\nmodule.network.aws_subnet.a: Creation complete after 1s [id=s]\n│ Error: boom\n│ \n│   with module.app.aws_instance.web,\n│ Error: no module named\n",
      ["network", "app"],
    );
    expect(ev.done.get("network")).toBe(1);
    expect(ev.started.get("network")).toBe(1);
    expect(ev.errored.get("app")).toBe("aws_instance.web: Error: boom");
    expect(ev.other).toEqual(["Error: no module named"]);
  });

  test("without the post-apply plan, the printed completions say how far a failed apply got", () => {
    const c = { order: ["network", "app"], modules: new Map([["network", "network"], ["app", "app"]]) };
    const planned = new Map([["network", 2], ["app", 1]]);
    const out = "module.network.aws_subnet.a: Creation complete after 1s [id=s]\n";
    expect(estateOutcomes(c, planned, out, 1).members).toEqual({
      network: { status: "partial", done: 1, planned: 2 },
      app: { status: "not-started", done: 0, planned: 1 },
    });
    // The post-apply plan wins over the text: network plans nothing more.
    expect(estateOutcomes(c, planned, out, 1, new Map([["network", 0], ["app", 1]])).members.network).toEqual({ status: "applied", done: 2, planned: 2 });
  });
});

describe("one reader of prior_state", () => {
  test("report.ts and the estate run read prior_state only through applied-state", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of [join(here, "..", "report.ts"), join(here, "estate.ts")]) {
      const code = readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code).toMatch(/from "\.\.?\/(\.\.\/)?applied-state"/);
      expect(code).not.toMatch(/prior_state/);
    }
  });
});
