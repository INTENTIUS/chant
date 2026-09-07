/**
 * The two live-root refusals against both config file formats (#2216).
 *
 * `TerraformApplyOp` and `TerraformWatchOp` each resolve a root's mode
 * synchronously when they are built, and `resolveRootModeSync` reads a
 * `chant.config.json` and nothing else: a `chant.config.ts` is project-
 * authored code it will not evaluate. Every project in this repository is on
 * a `chant.config.ts`, so a refusal that lives only in a composite has never
 * fired for anyone. TF027 and TF028 read the mode the build stamps onto the
 * parsed HCL instead, which is the same either way, and these tests
 * materialise one project in each format to prove it.
 *
 * The build path here is the plugin's own `buildRoots` hook (what `chant
 * build` calls to turn `terraform.roots` into entities) followed by the
 * checks the plugin contributes, so the entities under test are the ones a
 * real build produces rather than a hand-assembled map.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { terraformPlugin } from "../../plugin";
import { TerraformApplyOp } from "../../composites/terraform-apply-op";
import { TerraformWatchOp } from "../../composites/terraform-watch-op";

const UNTAGGED_DELETE_ROOT = `terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "prod-estate"

    policy {
      undeclared_untagged = "delete"
    }
  }
}

resource "null_resource" "first" {}
`;

const LIVE_ROOT = `terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "prod-estate"
  }
}

resource "null_resource" "first" {}
`;

const CONFIG = {
  lexicons: ["terraform"],
  terraform: { binary: "choudoufu", roots: { estate: { dir: "./estate" } } },
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project whose one root is `mainTf`, its config written in `format`. */
function project(format: "ts" | "json", mainTf: string): string {
  const dir = mkdtempSync(join(tmpdir(), `chant-tf-2216-${format}-`));
  dirs.push(dir);
  mkdirSync(join(dir, "estate"), { recursive: true });
  writeFileSync(join(dir, "estate", "main.tf"), mainTf);
  writeFileSync(
    join(dir, `chant.config.${format}`),
    format === "json"
      ? JSON.stringify(CONFIG, null, 2)
      : `import type { ChantConfig } from "@intentius/chant/config";\n\nexport default ${JSON.stringify(CONFIG, null, 2)} satisfies ChantConfig;\n`,
  );
  return dir;
}

/** `chant build`'s own path: the plugin's `buildRoots`, then the checks it contributes. */
async function checkProject(dir: string, ops: Map<string, Declarable> = new Map()): Promise<PostSynthDiagnostic[]> {
  const { entities } = await terraformPlugin.buildRoots!({ projectRoot: dir, config: CONFIG, entities: new Map() });
  for (const [name, op] of ops) entities.set(name, op);
  const ctx = { outputs: new Map(), entities } as unknown as PostSynthContext;
  return (terraformPlugin.postSynthChecks?.() ?? []).flatMap((check) => check.check(ctx));
}

describe('TF027 fires on undeclared_untagged = "delete" whatever the config format (#2216)', () => {
  for (const format of ["ts", "json"] as const) {
    test(`chant.config.${format}: the build reports the root and the setting`, async () => {
      const diags = await checkProject(project(format, UNTAGGED_DELETE_ROOT));
      const tf027 = diags.filter((d) => d.checkId === "TF027");
      expect(tf027).toHaveLength(1);
      expect(tf027[0].severity).toBe("error");
      expect(tf027[0].message).toContain('Root module "estate"');
      expect(tf027[0].message).toContain('undeclared_untagged = "delete"');
    });
  }

  test("the same project with no such policy setting is clean", async () => {
    const diags = await checkProject(project("ts", LIVE_ROOT));
    expect(diags.filter((d) => d.checkId === "TF027")).toEqual([]);
  });

  test("the composite's own refusal fires only on the format it can read, which is why the check exists", () => {
    const json = project("json", UNTAGGED_DELETE_ROOT);
    expect(() => TerraformApplyOp({ name: "estate-apply", root: "estate", cwd: json })).toThrow(
      /undeclared_untagged = "delete"/,
    );

    const ts = project("ts", UNTAGGED_DELETE_ROOT);
    expect(() => TerraformApplyOp({ name: "estate-apply", root: "estate", cwd: ts })).not.toThrow();
  });
});

describe("TF028 reports a stock-mode watch Op on a live root whatever the config format (#2216)", () => {
  test("chant.config.ts: the composite builds, and the build reports the Op", async () => {
    const dir = project("ts", LIVE_ROOT);
    const { op } = TerraformWatchOp({ name: "estate-watch", root: "estate", cwd: dir });
    const diags = await checkProject(dir, new Map([["estate-watch", op as unknown as Declarable]]));
    const tf028 = diags.filter((d) => d.checkId === "TF028");
    expect(tf028).toHaveLength(1);
    expect(tf028[0].message).toContain('Op "estate-watch"');
    expect(tf028[0].message).toContain('root module "estate"');
  });

  test("chant.config.json: the composite refuses before there is an Op to check", () => {
    const dir = project("json", LIVE_ROOT);
    expect(() => TerraformWatchOp({ name: "estate-watch", root: "estate", cwd: dir })).toThrow(
      /runs choudoufu with a declared estate/,
    );
  });

  test("live: true on the same root is clean in both formats", async () => {
    for (const format of ["ts", "json"] as const) {
      const dir = project(format, LIVE_ROOT);
      const { op } = TerraformWatchOp({ name: "estate-watch", root: "estate", live: true, cwd: dir });
      const diags = await checkProject(dir, new Map([["estate-watch", op as unknown as Declarable]]));
      expect(diags.filter((d) => d.checkId === "TF028")).toEqual([]);
    }
  });
});
