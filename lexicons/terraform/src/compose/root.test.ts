/**
 * The composed root (#4441): what `writeComposedRoot` and `writeEstateRoot`
 * write, and that `restore()` puts every file back. The validate case runs
 * `tofu` (or `terraform`) over roots of `terraform_data` with local state,
 * so nothing downloads a provider; it is skipped when neither is on the PATH.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { stackOutput } from "@intentius/chant/components/component";
import { compositionFor, type Composition } from "../compose";
import type { TerraformConfig } from "../config";
import { COMPOSE_DIR, COMPOSE_FILE, memberVars, unionLock, writeComposedRoot, writeEstateRoot, type ComposedRootInput } from "./root";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-compose-root-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** Every file under `dir`, by path relative to it, as bytes in hex. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const n of readdirSync(at).sort()) {
      const p = join(at, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p).toString("hex");
    }
  };
  walk(dir);
  return out;
}

function which(bin: string): boolean {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const BINARY = which("tofu") ? "tofu" : which("terraform") ? "terraform" : undefined;

const tf = (name: string, vars?: Record<string, unknown>, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name, ...(vars ? { vars } : {}) }] }],
});

const rootsOf = (...names: string[]): TerraformConfig["roots"] => Object.fromEntries(names.map((n) => [n, { dir: `roots/${n}` }]));

// net (HCL, local backend), app (HCL, reads net and a root outside the set through terraform_remote_state),
// edge (JSON syntax, reads net through terraform_remote_state and app through its step's vars).
const NET = `terraform {
  backend "local" {
    path = "net.tfstate"
  }
}

resource "terraform_data" "vpc" {
  input = "10.0.0.0/16"
}

moved {
  from = terraform_data.old
  to   = terraform_data.vpc
}

output "cidr" {
  value = terraform_data.vpc.output
}
`;

const APP = `data "terraform_remote_state" "net" {
  backend = "local"
  config = {
    path = "../net/net.tfstate"
  }
}

# A root outside the composed run: this read stays.
data "terraform_remote_state" "outside" {
  backend = "local"
  config = {
    path = "../outside/terraform.tfstate"
  }
}

variable "name" {
  type = string
}

resource "terraform_data" "app" {
  input = "\${var.name} in \${data.terraform_remote_state.net.outputs.cidr} near \${data.terraform_remote_state.outside.outputs.id}"
}

output "url" {
  value = terraform_data.app.output
}
`;

const EDGE = `${JSON.stringify(
  {
    variable: { app_url: { type: "string" }, cert: { type: "string" } },
    data: { terraform_remote_state: { net: { backend: "local", config: { path: "../net/net.tfstate" } } } },
    resource: { terraform_data: { edge: { input: "${var.app_url} ${var.cert} ${data.terraform_remote_state.net.outputs.cidr}" } } },
    output: { host: { value: "${terraform_data.edge.output}", sensitive: true } },
  },
  null,
  2,
)}\n`;

const OUTSIDE = 'resource "terraform_data" "o" {}\n\noutput "id" {\n  value = terraform_data.o.id\n}\n';

/** A component of another kind outside the group, whose output edge reads. */
const CERTS: DriverComponent = { name: "certs", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell", run: "true" }] }] };

function threeRoots(extra: Record<string, string> = {}): { dir: string; components: DriverComponent[]; c: Composition; input: ComposedRootInput } {
  const dir = project({
    "roots/net/main.tf": NET,
    "roots/app/main.tf": APP,
    "roots/app/terraform.tfvars": 'name = "app"\n',
    "roots/edge/main.tf.json": EDGE,
    "roots/outside/main.tf": OUTSIDE,
    ...extra,
  });
  const components = [tf("edge", { app_url: stackOutput("app", "url"), cert: stackOutput("certs", "arn") }), tf("app"), tf("net"), CERTS];
  const terraform: TerraformConfig = { roots: rootsOf("net", "app", "edge"), compose: { enabled: true } };
  const c = compositionFor({ projectRoot: dir, components, terraform, env: {} });
  return { dir, components, c, input: { projectRoot: dir, composition: c, terraform, env: {}, vars: memberVars(components, c), componentOutputs: { certs: { arn: "arn:aws:acm:cert/1" } } } };
}

const modulesIn = (main: string): string[] => [...main.matchAll(/^module "([^"]+)"/gm)].map((m) => m[1]!);
const moduleBody = (main: string, name: string): string => main.match(new RegExp(`^module "${name}" \\{\\n([\\s\\S]*?)\\n\\}`, "m"))?.[1] ?? "";

describe("writeComposedRoot", () => {
  test("three roots, one in JSON syntax: one module call per root, in order", () => {
    const { dir, c, input } = threeRoots();
    expect(c.fallback).toBeUndefined();
    expect(c.order).toEqual(["net", "app", "edge"]);
    const root = writeComposedRoot(input);
    try {
      expect(root.dir).toBe(join(dir, COMPOSE_DIR));
      const main = readFileSync(join(root.dir, "main.tf"), "utf-8");
      expect(modulesIn(main)).toEqual(["net", "app", "edge"]);
      expect(moduleBody(main, "net")).toContain('source = "../roots/net"');
      expect(moduleBody(main, "edge")).toContain('source = "../roots/edge"');
      expect(main).toContain('output "edge__host" {\n  value = module.edge.host\n  sensitive = true\n}');
      expect(main).toContain('output "net__cidr" {\n  value = module.net.cidr\n}');
      // The backend is cut; the moved block stays in the root.
      const net = readFileSync(join(dir, "roots/net/main.tf"), "utf-8");
      expect(net).not.toMatch(/backend\s+"local"/);
      expect(net).toContain("moved {");
      expect(main).not.toContain("moved");
      expect(root.rewritten).toEqual(["roots/app/main.tf", "roots/edge/main.tf.json", "roots/net/main.tf"]);
    } finally {
      root.restore();
    }
  });

  test.skipIf(!BINARY)("validate passes on the composed root", () => {
    const { input } = threeRoots();
    const root = writeComposedRoot(input);
    try {
      execFileSync(BINARY!, ["init", "-backend=false", "-input=false", "-no-color"], { cwd: root.dir, stdio: "pipe" });
      execFileSync(BINARY!, ["validate", "-no-color"], { cwd: root.dir, stdio: "pipe" });
    } finally {
      rmSync(join(root.dir, ".terraform"), { recursive: true, force: true });
      rmSync(join(root.dir, ".terraform.lock.hcl"), { force: true });
      root.restore();
    }
  });

  test("a terraform_remote_state read of a member is cut and resolves through a variable filled from the upstream module; a read outside the set stays", () => {
    const { dir, input } = threeRoots();
    const root = writeComposedRoot(input);
    try {
      const app = readFileSync(join(dir, "roots/app/main.tf"), "utf-8");
      expect(app).not.toContain('data "terraform_remote_state" "net"');
      expect(app).toContain("var.chant_read_net.outputs.cidr");
      expect(app).toContain('data "terraform_remote_state" "outside"');
      expect(app).toContain("data.terraform_remote_state.outside.outputs.id");
      expect(readFileSync(join(dir, "roots/app", COMPOSE_FILE), "utf-8")).toContain('variable "chant_read_net" {\n  type = any\n}');

      const edge = JSON.parse(readFileSync(join(dir, "roots/edge/main.tf.json"), "utf-8")) as Record<string, unknown>;
      expect(edge.data).toBeUndefined();
      expect(JSON.stringify(edge.resource)).toContain("${var.chant_read_net.outputs.cidr}");

      const main = readFileSync(join(root.dir, "main.tf"), "utf-8");
      expect(moduleBody(main, "app")).toContain("chant_read_net = { outputs = module.net }");
      expect(moduleBody(main, "app")).not.toContain("outside");
      expect(moduleBody(main, "edge")).toContain("chant_read_net = { outputs = module.net }");
      // The root's tfvars become module arguments.
      expect(moduleBody(main, "app")).toContain('name = "app"');
    } finally {
      root.restore();
    }
  });

  test("a vars read of a member becomes module.<upstream>.<output>; a read of a component outside the group stays a literal", () => {
    const { dir, input } = threeRoots();
    const root = writeComposedRoot(input);
    try {
      const edge = moduleBody(readFileSync(join(root.dir, "main.tf"), "utf-8"), "edge");
      expect(edge).toContain("app_url = module.app.url");
      expect(edge).toContain('cert = "arn:aws:acm:cert/1"');
      // The edge root itself is not given a variable for a vars read.
      expect(readFileSync(join(dir, "roots/edge", COMPOSE_FILE), "utf-8")).not.toContain("app_url");
    } finally {
      root.restore();
    }
  });

  test("step vars win over the root's tfvars, as -var does", () => {
    const { dir, components, input } = threeRoots();
    const withName = components.map((x) => (x.name === "app" ? tf("app", { name: "from-step" }) : x));
    const root = writeComposedRoot({ ...input, vars: memberVars(withName, input.composition) });
    try {
      expect(moduleBody(readFileSync(join(dir, COMPOSE_DIR, "main.tf"), "utf-8"), "app")).toContain('name = "from-step"');
    } finally {
      root.restore();
    }
  });

  test("an outside read with no value yet throws and puts every file back", () => {
    const { dir, input } = threeRoots();
    const before = snapshot(dir);
    expect(() => writeComposedRoot({ ...input, componentOutputs: {} })).toThrow(/certs\.arn/);
    expect(snapshot(dir)).toEqual(before);
  });

  test("import blocks with a literal id and removed blocks are lifted with the module prefix; moved blocks stay in the root", () => {
    const dir = project({
      "roots/a/main.tf": `resource "terraform_data" "x" {}

import {
  to = terraform_data.x
  id = "abc"
}

removed {
  from = terraform_data.gone
  lifecycle {
    destroy = false
  }
}

moved {
  from = terraform_data.y
  to   = terraform_data.x
}
`,
      "roots/b/main.tf.json": `${JSON.stringify({ resource: { terraform_data: { z: {} } }, import: [{ to: "terraform_data.z", id: "z-1" }], removed: { from: "terraform_data.old" } }, null, 2)}\n`,
    });
    const terraform: TerraformConfig = { roots: rootsOf("a", "b"), compose: { enabled: true } };
    const c = compositionFor({ projectRoot: dir, components: [tf("a"), tf("b")], terraform, env: {} });
    expect(c.fallback).toBeUndefined();
    const root = writeComposedRoot({ projectRoot: dir, composition: c, terraform, env: {} });
    try {
      const main = readFileSync(join(root.dir, "main.tf"), "utf-8");
      expect(main).toContain('import {\n  to = module.a.terraform_data.x\n  id = "abc"\n}');
      expect(main).toContain("removed {\n  from = module.a.terraform_data.gone\n  lifecycle {\n    destroy = false\n  }\n}");
      expect(main).toContain('import {\n  to = module.b.terraform_data.z\n  id = "z-1"\n}');
      expect(main).toContain("removed {\n  from = module.b.terraform_data.old\n}");
      expect(main).not.toContain("moved");
      const a = readFileSync(join(dir, "roots/a/main.tf"), "utf-8");
      expect(a).not.toMatch(/^\s*(import|removed)\s*\{/m);
      expect(a).toContain("moved {\n  from = terraform_data.y");
      const b = JSON.parse(readFileSync(join(dir, "roots/b/main.tf.json"), "utf-8")) as Record<string, unknown>;
      expect(b.import).toBeUndefined();
      expect(b.removed).toBeUndefined();
    } finally {
      root.restore();
    }
  });

  test("the union lock file holds every hash any root's lock file has for each provider", () => {
    const lock = (hashes: string[]): string =>
      `provider "registry.opentofu.org/hashicorp/random" {\n  version     = "3.6.0"\n  constraints = "~> 3.6"\n  hashes = [\n${hashes.map((h) => `    "${h}",`).join("\n")}\n  ]\n}\n`;
    const { dir, input } = threeRoots({
      "roots/net/.terraform.lock.hcl": lock(["h1:aaa=", "zh:111"]),
      "roots/app/.terraform.lock.hcl": lock(["h1:bbb=", "zh:111"]),
      "roots/edge/.terraform.lock.hcl": `${lock(["h1:ccc="])}\nprovider "registry.opentofu.org/hashicorp/null" {\n  version = "3.2.0"\n  hashes = [\n    "h1:nnn=",\n  ]\n}\n`,
    });
    const root = writeComposedRoot(input);
    try {
      const text = readFileSync(join(root.dir, ".terraform.lock.hcl"), "utf-8");
      expect(text).toBe(unionLock(["net", "app", "edge"].map((r) => join(dir, "roots", r))));
      const random = text.slice(text.indexOf('provider "registry.opentofu.org/hashicorp/random"'));
      for (const h of ["h1:aaa=", "h1:bbb=", "h1:ccc=", "zh:111"]) expect(random).toContain(`"${h}"`);
      expect(random).toContain('constraints = "~> 3.6"');
      expect(text).toContain('"h1:nnn="');
      expect(text.match(/hashicorp\/random/g)).toHaveLength(1);
    } finally {
      root.restore();
    }
  });

  test("the generated files' digests are returned", () => {
    const { dir, input } = threeRoots({ "roots/net/.terraform.lock.hcl": 'provider "registry.opentofu.org/hashicorp/null" {\n  version = "3.2.0"\n  hashes = [\n    "h1:n=",\n  ]\n}\n' });
    const root = writeComposedRoot(input);
    try {
      expect(root.generated.map(([p]) => p)).toEqual([
        `${COMPOSE_DIR}/.terraform.lock.hcl`,
        `${COMPOSE_DIR}/main.tf`,
        `roots/app/${COMPOSE_FILE}`,
        `roots/edge/${COMPOSE_FILE}`,
        `roots/net/${COMPOSE_FILE}`,
      ]);
      for (const [p, sha] of root.generated) expect(sha).toBe(createHash("sha256").update(readFileSync(join(dir, p))).digest("hex"));
    } finally {
      root.restore();
    }
  });

  test("after restore() every root file is byte-identical and the generated files are gone", () => {
    const { dir, input } = threeRoots();
    // A rewritten file with bytes that are not UTF-8 and a CRLF line comes back as it was.
    writeFileSync(join(dir, "roots/net/main.tf"), Buffer.concat([Buffer.from(NET), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0d, 0x0a])]));
    const before = snapshot(dir);
    const root = writeComposedRoot(input);
    expect(snapshot(dir)).not.toEqual(before);
    root.restore();
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, COMPOSE_DIR))).toBe(false);
    root.restore();
    expect(snapshot(dir)).toEqual(before);
  });

  test("a write that throws partway puts every file back, at each point it can fail", () => {
    const { dir, input } = threeRoots({ "roots/net/.terraform.lock.hcl": 'provider "registry.opentofu.org/hashicorp/null" {\n  version = "3.2.0"\n}\n' });
    const before = snapshot(dir);
    let failedAt = 0;
    for (let n = 1; ; n++) {
      let calls = 0;
      const write = (file: string, text: string): void => {
        if (++calls === n) {
          // Half the file lands before the failure.
          writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
          throw new Error(`injected failure at write ${n}`);
        }
        writeFileSync(file, text);
      };
      try {
        writeComposedRoot({ ...input, write }).restore();
        break;
      } catch (e) {
        expect((e as Error).message).toBe(`injected failure at write ${n}`);
        failedAt = n;
      }
      expect(snapshot(dir)).toEqual(before);
    }
    // Three rewritten roots, three generated root files, main.tf and the lock.
    expect(failedAt).toBe(8);
    expect(snapshot(dir)).toEqual(before);
  });

  test("throws, changing nothing, when a root already has the generated file's name", () => {
    const { dir, input } = threeRoots({ [`roots/app/${COMPOSE_FILE}`]: "# mine\n" });
    const before = snapshot(dir);
    expect(() => writeComposedRoot(input)).toThrow(`roots/app: ${COMPOSE_FILE} is already in the root`);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe("writeEstateRoot", () => {
  const live = (estate: string, body: string): string => `terraform {\n  live {\n    estate = "${estate}"\n  }\n}\n\n${body}`;

  test("only module calls of the estate directories, and no estate file changes", () => {
    const dir = project({
      "roots/net/main.tf": live("net", 'resource "terraform_data" "vpc" {}\n\noutput "id" {\n  value = terraform_data.vpc.id\n}\n'),
      "roots/app/main.tf": live(
        "app",
        'data "terraform_estate_outputs" "net" {\n  estate = "net"\n}\n\nresource "terraform_data" "app" {\n  input = data.terraform_estate_outputs.net.values.id\n}\n',
      ),
    });
    const terraform: TerraformConfig = { binary: "choudoufu", roots: rootsOf("net", "app"), compose: { enabled: true } };
    const c = compositionFor({ projectRoot: dir, components: [tf("net"), tf("app")], terraform, env: {} });
    expect(c.fallback).toBeUndefined();
    expect(c.estate).toBe(true);
    const before = snapshot(dir);
    expect(() => writeComposedRoot({ projectRoot: dir, composition: c, terraform, env: {} })).toThrow(/writeEstateRoot/);
    const root = writeEstateRoot({ projectRoot: dir, composition: c });
    try {
      expect(root.rewritten).toEqual([]);
      const main = readFileSync(join(root.dir, "main.tf"), "utf-8");
      expect(modulesIn(main)).toEqual(["net", "app"]);
      expect(moduleBody(main, "net")).toBe('  source = "../roots/net"');
      expect(moduleBody(main, "app")).toBe('  source = "../roots/app"');
      // Nothing else but the modules and their outputs re-exported.
      const blocks = [...main.matchAll(/^([a-z_]+)\s/gm)].map((m) => m[1]);
      expect(new Set(blocks)).toEqual(new Set(["module", "output"]));
      const after = snapshot(dir);
      for (const [p, bytes] of Object.entries(before)) expect(after[p]).toBe(bytes);
      expect(Object.keys(after).filter((p) => !(p in before))).toEqual([join(COMPOSE_DIR, "main.tf")]);
    } finally {
      root.restore();
    }
    expect(snapshot(dir)).toEqual(before);
  });
});
