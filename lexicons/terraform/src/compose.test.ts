/**
 * Which roots a change composes, in what order, and why the others fall back
 * (#4438). Each case writes the smallest project that produces it.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import type { DriverComponent, DriverPhase } from "@intentius/chant/components/driver";
import { stackOutput } from "@intentius/chant/components/component";
import { compositionFor, compositionIfEnabled, fallbackLine, moduleNames, withPlanFailed, type CompositionInput } from "./compose";
import type { TerraformConfig } from "./config";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A project with `files` under it, each path relative to it. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-compose-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const EMPTY = 'resource "terraform_data" "x" {}\n';

/** A component whose deploy is one terraform-apply step. */
function tf(name: string, opts: { root?: string; dependsOn?: string[]; vars?: Record<string, unknown>; before?: DriverPhase["steps"] } = {}): DriverComponent {
  return {
    name,
    dependsOn: opts.dependsOn ?? [],
    deploy: [{ phase: "Apply", steps: [...(opts.before ?? []), { kind: "terraform-apply", root: opts.root ?? name, ...(opts.vars ? { vars: opts.vars } : {}) }] }],
  };
}

/** Roots `names`, each at `roots/<name>`. */
const rootsOf = (...names: string[]): TerraformConfig["roots"] => Object.fromEntries(names.map((n) => [n, { dir: `roots/${n}` }]));

function input(projectRoot: string, components: DriverComponent[], over: Omit<Partial<CompositionInput>, "terraform"> & { terraform?: Partial<TerraformConfig> } = {}): CompositionInput {
  const { terraform, ...rest } = over;
  const roots = rootsOf(...components.flatMap((c) => c.deploy.flatMap((p) => p.steps)).flatMap((s) => {
      const root = (s as { root?: unknown }).root;
      return typeof root === "string" ? [root] : [];
    }));
  return { projectRoot, components, env: {}, terraform: { roots, compose: { enabled: true }, ...terraform }, ...rest };
}

/** Three independent roots a, b and c. */
const threeRoots = (extra: Record<string, string> = {}): string => project({ "roots/a/main.tf": EMPTY, "roots/b/main.tf": EMPTY, "roots/c/main.tf": EMPTY, ...extra });

describe("compositionFor: order, modules and reads", () => {
  test("B reads A and C reads B: order A, B, C, module names valid HCL identifiers and stable across runs", () => {
    const dir = project({ "roots/net-core/main.tf": EMPTY, "roots/2app/main.tf": EMPTY, "roots/edge.v1/main.tf": EMPTY });
    const components = [
      tf("c", { root: "edge.v1", dependsOn: ["b"], vars: { app_url: stackOutput("b", "url") } }),
      tf("a", { root: "net-core" }),
      tf("b", { root: "2app", dependsOn: ["a"], vars: { vpc_id: stackOutput("a", "vpc_id") } }),
    ];
    const first = compositionFor(input(dir, components));
    expect(first.fallback).toBeUndefined();
    expect(first.order).toEqual(["a", "b", "c"]);
    for (const name of first.modules.values()) expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(Object.fromEntries(first.modules)).toEqual({ a: "net_core", b: "r_2app", c: "edge_v1" });
    const again = compositionFor(input(dir, [...components].reverse()));
    expect(Object.fromEntries(again.modules)).toEqual(Object.fromEntries(first.modules));
    expect(again.order).toEqual(first.order);
  });

  test("moduleNames takes `_2` on a clash, in name order", () => {
    expect(Object.fromEntries(moduleNames(["a-b", "a_b", "."]))).toEqual({ ".": "root", "a-b": "a_b", a_b: "a_b_2" });
  });

  test("a read through vars and a read through terraform_remote_state both appear in reads", () => {
    const dir = project({
      "roots/a/main.tf": EMPTY,
      "roots/b/main.tf": 'data "terraform_remote_state" "net" {\n  backend = "local"\n  config = {\n    path = "../a/terraform.tfstate"\n  }\n}\n',
      "roots/c/main.tf": EMPTY,
    });
    const c = compositionFor(input(dir, [tf("a"), tf("b", { dependsOn: ["a"] }), tf("c", { dependsOn: ["a"], vars: { vpc: stackOutput("a", "vpc_id") } })]));
    expect(c.fallback).toBeUndefined();
    expect(c.reads.get("b")).toEqual([{ via: "remote-state", upstream: "a", name: "net" }]);
    expect(c.reads.get("c")).toEqual([{ via: "vars", upstream: "a", variable: "vpc", output: "vpc_id" }]);
    expect(c.order[0]).toBe("a");
  });
});

describe("compositionFor: each fallback", () => {
  test("too-many-roots", () => {
    const c = compositionFor(input(threeRoots(), [tf("a"), tf("b"), tf("c")], { terraform: { compose: { enabled: true, max: 2 } } }));
    expect(c.members).toEqual([]);
    expect(c.fallback).toEqual({ kind: "too-many-roots", reason: "this change composes 3 roots, more than `terraform.compose.max` (2)" });
  });

  test("one-root", () => {
    const c = compositionFor(input(project({ "roots/a/main.tf": EMPTY }), [tf("a")]));
    expect(c.fallback).toEqual({ kind: "one-root", member: "a", reason: "this change reaches one root, `a`, which applies in its own run" });
    expect(fallbackLine(c.fallback!)).toBe("**Applies in waves** (`terraform.compose`): this change reaches one root, `a`, which applies in its own run.");
  });

  test("binary", () => {
    const c = compositionFor(input(threeRoots(), [tf("a"), tf("b"), tf("c")], { binary: (m) => ({ name: "tofu", version: m === "c" ? "1.9.0" : "1.8.0" }) }));
    expect(c.members).toEqual(["a", "b"]);
    expect(c.fallbacks).toEqual([{ kind: "binary", member: "c", reason: "`c` runs tofu 1.9.0 and `a` tofu 1.8.0, and one run has one binary" }]);
  });

  test("identity", () => {
    const c = compositionFor(input(threeRoots(), [tf("a"), tf("b"), tf("c")], { identity: (m) => (m === "c" ? "role/other" : "role/apply") }));
    expect(c.members).toEqual(["a", "b"]);
    expect(c.fallbacks).toEqual([{ kind: "identity", member: "c", reason: "`c` applies under another cloud identity (`ci.identity.cloud`) than `a`, `b`, and one run has one set of credentials" }]);
  });

  test("workspace", () => {
    const dir = threeRoots();
    const c = compositionFor(input(dir, [tf("a"), tf("b"), tf("c")], { terraform: { roots: { ...rootsOf("a", "b"), c: { dir: "roots/c", workspace: "prod" } } } }));
    expect(c.fallbacks).toEqual([{ kind: "workspace", member: "c", reason: "`c` plans in workspace prod, and a composed run plans in default" }]);
  });

  test("backend: a type chant does not lock", () => {
    const c = compositionFor(input(threeRoots({ "roots/c/main.tf": 'terraform {\n  backend "consul" {\n    path = "c"\n  }\n}\n' }), [tf("a"), tf("b"), tf("c")]));
    expect(c.fallbacks).toEqual([{ kind: "backend", member: "c", reason: "`c`'s backend is consul, and chant locks only s3 (with use_lockfile), gcs, azurerm and local states itself" }]);
  });

  test("backend: s3 with no lock file", () => {
    const c = compositionFor(input(threeRoots({ "roots/c/main.tf": 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "c"\n  }\n}\n' }), [tf("a"), tf("b"), tf("c")]));
    expect(c.fallbacks).toEqual([{ kind: "backend", member: "c", reason: "`c`'s s3 backend takes no lock file (`use_lockfile = true`), so chant cannot hold its lock" }]);
  });

  test("provider-lock", () => {
    const lock = (v: string): string => `provider "registry.terraform.io/hashicorp/aws" {\n  version = "${v}"\n}\n`;
    const c = compositionFor(input(threeRoots({ "roots/a/.terraform.lock.hcl": lock("5.0.0"), "roots/c/.terraform.lock.hcl": lock("5.1.0") }), [tf("a"), tf("b"), tf("c")]));
    expect(c.fallbacks).toEqual([{ kind: "provider-lock", member: "c", reason: "`c` locks registry.terraform.io/hashicorp/aws at 5.1.0 and `a` at 5.0.0, and one run installs one version" }]);
  });

  test("cli-args", () => {
    const c = compositionFor(input(threeRoots(), [tf("a"), tf("b"), tf("c")], { env: { TF_CLI_ARGS_plan: "-target=aws_s3_bucket.x" } }));
    expect(c.members).toEqual([]);
    expect(c.fallback).toEqual({ kind: "cli-args", reason: "`TF_CLI_ARGS_plan` carries `-target`, which names a root's own addresses or variables, not the composed run's" });
  });

  test("read", () => {
    const dir = threeRoots({
      "roots/b/main.tf": 'data "terraform_remote_state" "net" {\n  count = 1\n  backend = "local"\n  config = {\n    path = "../a/terraform.tfstate"\n  }\n}\n',
    });
    const c = compositionFor(input(dir, [tf("a"), tf("b", { dependsOn: ["a"] }), tf("c")]));
    expect(c.members).toEqual(["a", "c"]);
    expect(c.fallbacks).toEqual([{ kind: "read", member: "b", reason: "`b` reads `a` through a block with count or for_each (`data.terraform_remote_state.net`)" }]);
  });

  test("order-only: two roots ordered only by dependsOn, with no read", () => {
    const c = compositionFor(input(threeRoots(), [tf("a"), tf("b", { dependsOn: ["a"] }), tf("c")]));
    expect(c.members).toEqual(["a", "c"]);
    expect(c.fallbacks).toEqual([
      { kind: "order-only", member: "b", reason: "`b` depends on `a` (`dependsOn`) with no read between them, and a module with its own providers takes no depends_on" },
    ]);
  });

  test("import", () => {
    const c = compositionFor(input(threeRoots({ "roots/c/main.tf": 'import {\n  to = terraform_data.x\n  id = var.id\n}\n' }), [tf("a"), tf("b"), tf("c")]));
    expect(c.fallbacks).toEqual([{ kind: "import", member: "c", reason: "an `import` block of `c` takes no literal string `id`, so it cannot be lifted into the composed root" }]);
  });

  test("path", () => {
    const c = compositionFor(input(threeRoots({ "roots/c/main.tf": 'locals {\n  here = path.root\n}\n' }), [tf("a"), tf("b"), tf("c")]));
    expect(c.fallbacks).toEqual([{ kind: "path", member: "c", reason: "`c` uses `path.root` or `path.cwd`, which would name the composed root instead of `roots/c`" }]);
  });

  test("plan-failed", () => {
    const c = withPlanFailed(compositionFor(input(threeRoots(), [tf("a"), tf("b"), tf("c")])), "Error: boom\nat line 3");
    expect(c.members).toEqual([]);
    expect(c.fallback).toEqual({ kind: "plan-failed", reason: "the composed plan failed: Error: boom" });
  });

  test("targets: a member given targets falls back with its own kind", () => {
    const c = compositionFor(input(threeRoots(), [tf("a"), tf("b"), tf("c")], { targets: { c: ["aws_s3_bucket.x"] } }));
    expect(c.members).toEqual(["a", "b"]);
    expect(c.fallbacks).toEqual([{ kind: "targets", member: "c", reason: "`c` is given 1 target (`--target`), and a composed run plans each member whole" }]);
    expect(fallbackLine(c.fallbacks[0]!)).toBe("**`c` applies in waves** (`terraform.compose`): `c` is given 1 target (`--target`), and a composed run plans each member whole.");
  });

  test("multi-step", () => {
    const c = compositionFor(input(threeRoots(), [tf("a"), tf("b"), tf("c", { before: [{ kind: "gate", gate: "ok" }] })]));
    expect(c.fallbacks).toEqual([{ kind: "multi-step", member: "c", reason: "`c`'s deploy has 2 steps, and only a component whose deploy is one terraform-apply step composes" }]);
  });

  test("same-root", () => {
    const c = compositionFor(input(threeRoots(), [tf("a"), tf("b"), tf("c"), tf("d", { root: "c" })]));
    expect(c.members).toEqual(["a", "b", "c"]);
    expect(c.fallbacks).toEqual([{ kind: "same-root", member: "d", reason: "`d` deploys root `c`, which `c` deploys too, and a composed run calls each root once" }]);
  });

  test("split: a component of another kind between two roots", () => {
    const stack: DriverComponent = { name: "s", dependsOn: ["a"], deploy: [{ phase: "Deploy", steps: [{ kind: "cfn-deploy", vars: { v: stackOutput("a", "vpc_id") } }] }] };
    const c = compositionFor(input(threeRoots(), [tf("a"), tf("b"), stack, tf("c", { dependsOn: ["s"], vars: { q: stackOutput("s", "QueueUrl") } })]));
    expect(c.members).toEqual(["a", "b"]);
    expect(c.fallbacks).toEqual([
      { kind: "split", member: "c", reason: "`c` depends on `a` through `s`, a cfn-deploy component that applies between them" },
    ]);
  });

  test("split: a root left out between two roots", () => {
    const c = compositionFor(
      input(threeRoots(), [tf("a"), tf("b", { dependsOn: ["a"], vars: { v: stackOutput("a", "x") } }), tf("c", { dependsOn: ["b"], vars: { v: stackOutput("b", "y") } })], {
        targets: { b: ["terraform_data.x"] },
      }),
    );
    expect(c.fallbacks.map((f) => f.kind)).toEqual(["targets", "split"]);
    expect(c.fallbacks[1]).toEqual({ kind: "split", member: "c", reason: "`c` depends on `a` through `b`, which is left out of the composed run and applies between them" });
    expect(c.fallback).toEqual({ kind: "one-root", member: "a", reason: "only `a` of this change can compose, and one root applies in its own run" });
  });
});

describe("terraform.compose is off by default", () => {
  test("compositionIfEnabled returns nothing with the setting unset or off", () => {
    const dir = threeRoots();
    const base = input(dir, [tf("a"), tf("b"), tf("c")]);
    expect(compositionIfEnabled({ ...base, terraform: { roots: base.terraform.roots } })).toBeUndefined();
    expect(compositionIfEnabled({ ...base, terraform: { roots: base.terraform.roots, compose: { enabled: false } } })).toBeUndefined();
    expect(compositionIfEnabled(base)?.members).toEqual(["a", "b", "c"]);
  });

  test("nothing in the lexicon calls compositionFor except through compositionIfEnabled", () => {
    const src = dirname(fileURLToPath(import.meta.url));
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n) && p !== join(src, "compose.ts") && /\bcompositionFor\s*\(/.test(readFileSync(p, "utf-8"))) callers.push(p);
      }
    };
    walk(src);
    expect(callers).toEqual([]);
  });
});
