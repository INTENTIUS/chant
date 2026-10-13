/**
 * `chant workspace graph` reads `terraform` and `choudoufu` members through
 * the terraform lexicon (#2874), end to end: the lexicon's own kinds file,
 * this checkout's chant as the members' toolchain, and a real HCL parse.
 *
 * The workspace links this checkout's `node_modules`, where the lexicon is
 * installed, and pins it at its version. Its `net` root calls
 * `../modules/subnets`, which lies outside the member but inside the
 * workspace, so the module's resources are only read when the reader
 * project's `moduleRoot` is the workspace root.
 */

import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, declaration, REPO, repo } from "./__fixtures__/contract-repo";
import { workspaceGraph, type GraphDocument } from "./graph-cli";
import schema from "./graph.schema.json";

afterAll(cleanScratch);

const { expectValid } = contract(schema);
const TIMEOUT = 240_000;
const LEXICON = "@intentius/chant-lexicon-terraform";
const VERSION = (JSON.parse(readFileSync(join(REPO, "lexicons", "terraform", "package.json"), "utf-8")) as { version: string }).version;

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("terraform and choudoufu members through the terraform lexicon (#2874)", () => {
  test(
    "compose with <member>/<root>/<address> ids, their local modules included",
    async () => {
      const root = repo({
        "chant.workspace.json": declaration(
          [
            { name: "net", dir: "estates/net", kind: "terraform" },
            { name: "shop", dir: "estates/shop", kind: "choudoufu" },
          ],
          { pins: [{ package: LEXICON, version: VERSION }] },
        ),
        "estates/net/main.tf": 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n\nmodule "subnets" {\n  source = "../modules/subnets"\n  vpc_id = aws_vpc.main.id\n}\n',
        "estates/modules/subnets/main.tf": 'variable "vpc_id" {}\n\nresource "aws_subnet" "a" {\n  vpc_id     = var.vpc_id\n  cidr_block = "10.0.1.0/24"\n}\n',
        "estates/shop/estate.chdf.hcl": 'estate = "shop"\n',
        "estates/shop/main.tf": 'resource "aws_sns_topic" "orders" {\n  name = "orders"\n}\n',
        ".gitignore": "node_modules\n",
      });
      symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");

      const { doc, failed } = await workspaceGraph({ cwd: root });
      const g = result(doc);
      expectValid(g);
      expect(g.members.map((m) => [m.name, m.kind, m.status, m.reason?.message ?? null])).toEqual([
        ["net", "terraform", "composed", null],
        ["shop", "choudoufu", "composed", null],
      ]);
      expect(failed).toBe(false);
      const ids = g.nodes.map((n) => n.id);
      expect(ids).toContain("net/net/aws_vpc.main");
      expect(ids).toContain("net/net/module.subnets/aws_subnet.a");
      expect(ids).toContain("shop/shop/aws_sns_topic.orders");
      expect(g.groups.byMember.net).toContain("net/net/module.subnets/aws_subnet.a");
    },
    TIMEOUT,
  );
});
