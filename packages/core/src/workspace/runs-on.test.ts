/**
 * `runsOn` on a member entry (#5101): the cluster resource the member runs
 * on, read from the declaration, with `--runs-on` setting it for a discovered
 * read.
 */
import { describe, expect, test } from "vitest";
import { parseArgs } from "../cli/parse-args";
import { parseDeclaration, WorkspaceReadError } from "./declaration";

const parse = (doc: unknown) => parseDeclaration(JSON.stringify(doc, null, 2), "chant.workspace.json");

describe("a member's runsOn", () => {
  test("reads as the entry wrote it, and is null when the entry names none", () => {
    const d = parse({
      name: "acme",
      schema: 1,
      members: [
        { name: "argo", dir: "argo", kind: "other", because: "x", runsOn: "infra/google_container_cluster.prod" },
        { name: "infra", dir: "infra", kind: "other", because: "x" },
      ],
    });
    expect(d.members.map((m) => m.runsOn)).toEqual(["infra/google_container_cluster.prod", null]);
  });

  test("is refused without a member and an address, or with a space", () => {
    for (const runsOn of ["google_container_cluster.prod", "infra/", "/x", "infra/a b", ""]) {
      expect(() => parse({ name: "acme", schema: 1, members: [{ name: "argo", dir: "argo", kind: "other", because: "x", runsOn }] }), runsOn).toThrow(WorkspaceReadError);
    }
  });
});

describe("--runs-on", () => {
  test("is repeatable and splits at the first =", () => {
    expect(parseArgs(["workspace", "graph", "--discover", "--runs-on", "argo=infra/google_container_cluster.prod", "--runs-on", "web=infra/aws_eks_cluster.a"]).runsOn).toEqual({
      argo: "infra/google_container_cluster.prod",
      web: "infra/aws_eks_cluster.a",
    });
  });

  test("needs a member and a target", () => {
    for (const value of ["argo", "=infra/x.y", "argo="]) {
      expect(() => parseArgs(["workspace", "graph", "--discover", "--runs-on", value]), value).toThrow(/--runs-on needs/);
    }
  });
});
