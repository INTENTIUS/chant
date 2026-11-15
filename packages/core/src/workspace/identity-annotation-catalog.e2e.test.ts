/**
 * A ServiceAccount to its cloud identity, and a Workload Identity binding back
 * to the ServiceAccount, through `chant workspace graph --discover` end to end
 * (#5099): a manifests member `k8s` and a terraform member `tf`.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { CACHE_DIR_ENV } from "./graph-cache";
import { workspaceGraph, type GraphDocument } from "./graph-cli";

const TIMEOUT = 240_000;

let cacheBefore: string | undefined;
beforeAll(() => {
  cacheBefore = process.env[CACHE_DIR_ENV];
  process.env[CACHE_DIR_ENV] = scratchDir("chant-id-cache-");
});
afterAll(() => {
  if (cacheBefore === undefined) delete process.env[CACHE_DIR_ENV];
  else process.env[CACHE_DIR_ENV] = cacheBefore;
  cleanScratch();
});

const serviceAccount = (name: string, key: string, value: string) =>
  `apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: ${name}\n  namespace: ci\n  annotations:\n    ${key}: ${value}\n`;

const FX = {
  "k8s/sa.yaml": [
    serviceAccount("runner", "iam.gke.io/gcp-service-account", "runner@demo-proj.iam.gserviceaccount.com"),
    serviceAccount("builder", "eks.amazonaws.com/role-arn", "arn:aws:iam::111122223333:role/ci-runner"),
    serviceAccount("ghost", "iam.gke.io/gcp-service-account", "ghost@demo-proj.iam.gserviceaccount.com"),
  ].join("---\n"),
  "tf/main.tf": [
    'resource "google_service_account" "runner" {',
    '  account_id = "runner"',
    '  project    = "demo-proj"',
    "}",
    "",
    'resource "google_service_account" "elsewhere" {',
    '  account_id = "runner"',
    '  project    = "other-proj"',
    "}",
    "",
    'resource "google_service_account_iam_member" "runner" {',
    "  service_account_id = google_service_account.runner.name",
    '  role               = "roles/iam.workloadIdentityUser"',
    '  member             = "serviceAccount:demo-proj.svc.id.goog[ci/runner]"',
    "}",
    "",
    'resource "aws_iam_role" "ci_runner" {',
    '  name               = "ci-runner"',
    "  assume_role_policy = \"{}\"",
    "}",
    "",
  ].join("\n"),
};

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("workspace graph: cloud identity rules (#5099)", () => {
  test(
    "draws ServiceAccount to account and role, binding to ServiceAccount, joins only the account of the project, and lists the account that is not there",
    async () => {
      const root = scratchDir("chant-id-fx-");
      writeFiles(root, FX);
      const { doc, failed } = await workspaceGraph({ cwd: root, discover: true, noCache: false, catalog: true });
      const g = result(doc);
      expect(failed).toBe(false);

      const sa = (name: string) => g.nodes.find((n) => n.kind === "K8s::Core::ServiceAccount" && n.id.toLowerCase().endsWith(name))!.id;
      const res = (address: string) => g.nodes.find((n) => n.id.endsWith(`/${address}`))!.id;
      const derived = g.edges.filter((e) => e.origin === "derived" && (e.rule?.includes("annotations[") || e.rule?.includes("service_account_iam_member")));
      expect(derived.map((e) => `${e.from} -> ${e.to}`).sort()).toEqual(
        [
          `${sa("runner")} -> ${res("google_service_account.runner")}`,
          `${sa("builder")} -> ${res("aws_iam_role.ci_runner")}`,
          `${res("google_service_account_iam_member.runner")} -> ${sa("runner")}`,
        ].sort(),
      );
      expect(derived.every((e) => e.relation === "reference" && e.grain === "property")).toBe(true);

      const dangling = (g.dangling ?? []).filter((d) => d.rule?.includes("annotations["));
      expect(dangling).toEqual([expect.objectContaining({ from: sa("ghost"), value: "ghost@demo-proj.iam.gserviceaccount.com", targetKind: "google_service_account" })]);
    },
    TIMEOUT,
  );
});
