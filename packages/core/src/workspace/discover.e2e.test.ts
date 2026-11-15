/**
 * `chant workspace graph <dir> --discover` end to end (#5095): a directory
 * with no declaration, read through the terraform and k8s lexicons installed
 * in this checkout, and nothing written inside it or in this repository's
 * git directory.
 *
 * The fixture is a plain directory, not a git repository, as a folder handed
 * to a viewer is. Its `infra/net` root calls `../modules/vpc`, which is a
 * module and no member, `argo` holds an Argo CD Application, and `db` is
 * claimed by two sql kinds at one precedence.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, REPO, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { CACHE_DIR_ENV } from "./graph-cache";
import { workspaceGraph, type GraphDocument } from "./graph-cli";
import schema from "./graph.schema.json";

const TIMEOUT = 240_000;
const { expectValid } = contract(schema);

let cacheBefore: string | undefined;
beforeAll(() => {
  cacheBefore = process.env[CACHE_DIR_ENV];
  process.env[CACHE_DIR_ENV] = scratchDir("chant-discover-cache-");
});
afterAll(() => {
  if (cacheBefore === undefined) delete process.env[CACHE_DIR_ENV];
  else process.env[CACHE_DIR_ENV] = cacheBefore;
  cleanScratch();
});

const FX = {
  "infra/net/main.tf":
    'provider "aws" {\n  region = "us-east-1"\n}\n\nresource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n\nmodule "vpc" {\n  source = "../modules/vpc"\n}\n',
  "infra/modules/vpc/main.tf": 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n',
  "argo/app.yaml":
    "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: web\n  namespace: argocd\nspec:\n  project: default\n  source:\n    repoURL: https://example.com/repo.git\n    path: apps/web\n  destination:\n    server: https://kubernetes.default.svc\n    namespace: web\n",
  "db/V1__init.sql": "create table orders (id int);\n",
  "db/1_init.up.sql": "create table orders (id int);\n",
};

/** Every path under `root` with its kind, mode, size, mtime and content hash. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const at = rel ? `${rel}/${name}` : name;
      const st = statSync(path);
      if (st.isDirectory()) {
        out.push(`d ${at} ${st.mode} ${st.mtimeMs}`);
        walk(path, at);
      } else {
        out.push(`f ${at} ${st.mode} ${st.size} ${st.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  };
  walk(root, "");
  return out;
}

/** What chant keeps in this repository's git directory: its refs and `.git/chant`. A worktree shares the main checkout's. */
function chantGitState(): string[] {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: REPO, encoding: "utf-8" }).trim();
  const dir = isAbsolute(common) ? common : join(REPO, common);
  const refs = execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/chant", "refs/tags/ci", "refs/chant"], { cwd: REPO, encoding: "utf-8" })
    .split("\n")
    .filter(Boolean);
  const own = join(dir, "chant");
  return [...refs, ...(existsSync(own) ? snapshot(own) : [])];
}

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("workspace graph --discover (#5095)", () => {
  test(
    "reads infra/net and argo as members, leaves the module and the tie out, and writes nothing",
    async () => {
      const root = scratchDir("chant-discover-fx-");
      writeFiles(root, FX);
      const before = snapshot(root);
      const gitBefore = chantGitState();

      const { doc, failed } = await workspaceGraph({ cwd: root, discover: true, noCache: false });
      const g = result(doc);
      expectValid(g);
      expect(g.contract).toBe(1);
      expect(failed).toBe(false);

      expect(g.members.map((m) => [m.name, m.dir, m.kind, m.status])).toEqual([
        ["argo", "argo", "argo-app", "composed"],
        ["infra-net", "infra/net", "terraform", "composed"],
      ]);
      // The module is read with the root that calls it, and is no member of its own.
      const ids = g.nodes.map((n) => n.id);
      expect(ids).toContain("infra-net/infra-net/aws_s3_bucket.logs");
      expect(ids).toContain("infra-net/infra-net/module.vpc/aws_vpc.main");
      expect(ids.some((id) => id.startsWith("argo/"))).toBe(true);

      expect(g.discovered!.map((e) => [e.dir, e.outcome, e.member, e.kind])).toEqual([
        ["argo", "member", "argo", "argo-app"],
        ["db", "tie", null, null],
        ["infra/modules/vpc", "module", null, "terraform"],
        ["infra/net", "member", "infra-net", "terraform"],
      ]);
      const tie = g.discovered!.find((e) => e.dir === "db")!;
      expect(tie.claims.filter((c) => c.precedence === tie.claims[0].precedence).map((c) => c.kind)).toEqual(["flyway", "golang-migrate"]);

      expect(snapshot(root)).toEqual(before);
      expect(chantGitState()).toEqual(gitBefore);
    },
    TIMEOUT,
  );
});
