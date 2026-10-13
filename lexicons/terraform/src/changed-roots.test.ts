/**
 * Which `terraform.roots` a change touches (#3183): a file in the root's
 * directory, in a local module it calls (and modules those call), or one of
 * its var files.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { changedRoots, rootWatchPaths } from "./changed-roots";

const project = mkdtempSync(join(tmpdir(), "chant-changed-roots-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, path), text);
}

write("roots/net/main.tf", 'module "vpc" {\n  source = "../../modules/vpc"\n}\n');
write("roots/app/main.tf", 'module "svc" {\n  source = "../../modules/svc//inner"\n}\nmodule "reg" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n');
write("roots/dns/main.tofu", 'resource "terraform_data" "z" {}\n');
write("modules/vpc/main.tf", 'module "subnets" {\n  source = "./subnets"\n}\n');
write("modules/vpc/subnets/main.tf", "");
write("modules/svc/inner/main.tf", "");
write("envs/prod.tfvars", "");

const ROOTS = {
  net: { dir: "roots/net" },
  app: { dir: "./roots/app", varFiles: ["../../envs/prod.tfvars"] },
  dns: { dir: "roots/dns" },
};

describe("rootWatchPaths", () => {
  test("a root watches its directory, each local module it reaches and its var files", () => {
    expect(rootWatchPaths(project, ROOTS.net)).toEqual(["modules/vpc", "modules/vpc/subnets", "roots/net"]);
    expect(rootWatchPaths(project, ROOTS.app)).toEqual(["envs/prod.tfvars", "modules/svc/inner", "roots/app"]);
  });
});

describe("changedRoots", () => {
  test("a file in a root's directory touches that root alone", () => {
    expect(changedRoots(project, ROOTS, ["roots/dns/main.tofu"])).toEqual(["dns"]);
  });

  test("a file in a module two calls deep touches the root that calls it", () => {
    expect(changedRoots(project, ROOTS, ["modules/vpc/subnets/main.tf"])).toEqual(["net"]);
  });

  test("a var file touches the root that reads it", () => {
    expect(changedRoots(project, ROOTS, ["envs/prod.tfvars"])).toEqual(["app"]);
  });

  test("a registry source is not followed, and a file nothing reads touches nothing", () => {
    expect(changedRoots(project, ROOTS, ["README.md", "roots/netsplit/main.tf"])).toEqual([]);
  });
});

describe("changedRoots in a workspace member (#3465)", () => {
  // The project is a member at infra/network. Its root calls a module that
  // lives outside the member, and the changed files come relative to the
  // member, so a file outside it reads `../...`.
  const repo = mkdtempSync(join(tmpdir(), "chant-changed-roots-member-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  put("infra/network/roots/vpc/main.tf", 'module "base" {\n  source = "../../../../shared/modules/base"\n}\n');
  put("shared/modules/base/main.tf", "");
  put("apps/web/main.tf", "");
  const member = join(repo, "infra/network");
  const roots = { vpc: { dir: "roots/vpc" } };

  test("a module outside the member is watched by a path that leaves it", () => {
    expect(rootWatchPaths(member, roots.vpc)).toEqual(["../../shared/modules/base", "roots/vpc"]);
  });

  test("a change to that module touches the root; a change in another member touches nothing", () => {
    expect(changedRoots(member, roots, ["../../shared/modules/base/main.tf"])).toEqual(["vpc"]);
    expect(changedRoots(member, roots, ["../../apps/web/main.tf"])).toEqual([]);
  });
});
