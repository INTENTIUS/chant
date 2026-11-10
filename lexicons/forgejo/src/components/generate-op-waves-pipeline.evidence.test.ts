/**
 * #4926 on forgejo: the github waves workflow under the Forgejo dialect, so a
 * wave that trades cloud credentials and signs keyless renders an evidence
 * job, with `enable-openid-connect` in place of `id-token: write`, and the
 * policy is a step of its own whose result that job reads.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const cloud = { aws: { role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
const spec: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  step: { kind: "terraform-apply", root: "{target}" },
  holds: { policy: true },
  waves: [{ name: "dev", runs: [{ target: "network" }], cloud }],
};

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string };
type Job = { needs?: string[]; "enable-openid-connect"?: boolean; steps: Step[] };

describe("a wave's evidence job on forgejo (#4926)", () => {
  test("a keyless wave that trades cloud credentials renders an evidence job instead of refusing", () => {
    const yaml = generateForgejoOpWavesPipeline(spec, { specFile: ".chant/op-waves/roots.spec.json", evidence: { identity: "oidc" } }).files[0]!.yaml;
    const jobs = (parseYAML(yaml) as { jobs: Record<string, Job> }).jobs;
    expect(jobs["wave-1-dev"]!.steps.find((s) => s.id === "chant-policy")!.run).toContain("chant run wave --spec .chant/op-waves/roots.spec.json --wave 1 --policy-only");
    const ev = jobs["wave-1-dev-evidence"]!;
    expect(ev.needs).toEqual(["wave-1-dev"]);
    expect(ev["enable-openid-connect"]).toBe(true);
    const sign = ev.steps.at(-1)!;
    // Forgejo drops continue-on-error, so the signing step runs after a missing claims artifact by its own `if:`.
    expect(sign.if).toBe("!cancelled()");
    expect(sign.run).toContain("chant ci evidence sign --from-job wave-1-dev --check-id plan:dev,policy:dev ");
    expect(JSON.parse(sign.env!.CHANT_EVIDENCE_SOURCES!)["policy:dev"]).toEqual({ step: "Check wave 1 (dev)'s plans against the policy" });
  });
});
