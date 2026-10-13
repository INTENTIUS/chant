import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { auditFiles, type AuditFinding, type ChecksProvider, type EntitiesProvider } from "@intentius/chant/audit/core";
import { discoverByDetection, type DetectPlugin } from "@intentius/chant/audit/discover";
import { terraformPlugin } from "../../plugin";
import { postSynthChecks } from "./index";

/**
 * Epic #2284's definition of done, run through `chant audit`'s terraform path
 * (real discovery, the plugin's `auditEntities` parse, every post-synth check
 * in the barrel) over the two estate roots in `fixtures/estate-2284/`. The
 * violating root holds one violation per rule, TF030 to TF037; the clean root
 * holds the same estate fixed, with the provider-default cases (an SQS queue
 * with no encryption attribute, an EBS volume behind an enabled
 * `aws_ebs_encryption_by_default`) left as real estates leave them.
 */
const estate = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "estate-2284");

const terraformDetectPlugin: DetectPlugin = { name: "terraform" };
const checksProvider: ChecksProvider = async (lexicon) =>
  lexicon === "terraform" ? (terraformPlugin.postSynthChecks?.() ?? []) : [];
const entitiesProvider: EntitiesProvider = async (lexicon) =>
  lexicon === "terraform" ? terraformPlugin.auditEntities?.bind(terraformPlugin) : undefined;

async function audit(root: "violating" | "clean"): Promise<AuditFinding[]> {
  return auditFiles(discoverByDetection(join(estate, root), [terraformDetectPlugin]), { checksProvider, entitiesProvider });
}

/** The rule each violating resource is written for. */
const EXPECTED: Record<string, string> = {
  TF030: "aws_security_group.bastion",
  TF031: "aws_iam_policy.deployer",
  TF032: "aws_ecs_task_definition.api",
  TF033: "aws_db_instance.ledger",
  TF034: "aws_sns_topic.alerts",
  TF035: "aws_sqs_queue.settlements",
  TF036: "aws_ebs_volume.scratch",
  TF037: "aws_ecr_repository.api",
};

const FAMILY = /^TF03[0-7]$/;

describe("epic #2284 acceptance: chant audit over the estate roots", () => {
  test("every rule TF030 to TF037 is in the barrel", () => {
    const shipped = new Set(postSynthChecks.map((c) => c.id));
    expect(Object.keys(EXPECTED).filter((id) => !shipped.has(id))).toEqual([]);
  });

  for (const [id, address] of Object.entries(EXPECTED)) {
    test(`the violating root reports ${id} on ${address}`, async () => {
      const findings = (await audit("violating")).filter((f) => f.checkId === id);
      expect(findings.map((f) => f.entity)).toEqual([`audit-root/${address}`]);
      expect(["error", "warning"]).toContain(findings[0]!.severity);
    });
  }

  test("the violating root reports nothing TF030 to TF037 cannot prove", async () => {
    const family = (await audit("violating")).filter((f) => FAMILY.test(f.checkId));
    expect(family.filter((f) => f.severity === "info")).toEqual([]);
    expect(family.map((f) => f.checkId).sort()).toEqual(Object.keys(EXPECTED));
  });

  test("the clean root, provider-default cases included, reports nothing from TF030 to TF037", async () => {
    const family = (await audit("clean")).filter((f) => FAMILY.test(f.checkId));
    expect(family).toEqual([]);
  });
});
