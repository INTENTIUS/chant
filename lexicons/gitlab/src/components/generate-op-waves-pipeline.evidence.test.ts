/**
 * #4926 on gitlab: GitLab reports no steps, so a wave's policy runs in a job
 * of its own, `<wave job>-policy`, and the evidence job after the wave job
 * signs `policy:<wave>` from that job's status, and `plan:<wave>` from the
 * wave job's for a wave that trades cloud credentials and signs keyless.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const cloud = { aws: { role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
const spec: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  step: { kind: "terraform-apply", root: "{target}" },
  holds: { policy: true },
  evidence: { requires: ["plan:dev"] },
  waves: [{ name: "dev", runs: [{ target: "network" }], cloud, environment: { name: "dev" } }, { name: "prod", runs: [{ target: "network" }] }],
};

type Job = { stage: string; needs?: string[]; script: string[]; variables: Record<string, string>; id_tokens?: Record<string, { aud: string }>; allow_failure?: unknown; environment?: Record<string, string>; artifacts?: { paths: string[] } };
const docOf = (s: OpWavesSpec, evidence: object) => parseYAML(generateGitlabOpWavesPipeline(s, { specFile: ".chant/op-waves/roots.spec.json", evidence }).files[0]!.yaml) as Record<string, Job>;

describe("a wave's policy and evidence jobs on gitlab (#4926)", () => {
  test("the policy runs in its own job, an allowed failure the wave job needs", () => {
    const doc = docOf(spec, { identity: "oidc" });
    const policy = doc["wave-1-dev-policy"]!;
    expect(policy.stage).toBe("wave-1-dev");
    expect(policy.script.at(-1)).toBe("chant run wave --spec .chant/op-waves/roots.spec.json --wave 1 --policy-only");
    expect(policy.allow_failure).toBe(true);
    expect(policy.environment).toEqual({ name: "dev", action: "prepare" });
    // It trades for the wave's cloud identities, and requests no signing token.
    expect(Object.keys(policy.id_tokens!)).toEqual(["CHANT_ID_TOKEN_AWS"]);
    expect(policy.artifacts!.paths).toEqual([".chant/op-waves/roots/checks/"]);
    expect(doc["wave-1-dev"]!.needs).toEqual(["wave-1-dev-policy"]);
  });

  test("a keyless wave that trades cloud credentials signs plan and policy in its evidence job, from the jobs' statuses", () => {
    const doc = docOf(spec, { identity: "oidc" });
    const wave = doc["wave-1-dev"]!;
    expect(wave.variables.CHANT_WAVE_EVIDENCE).toBe("job");
    expect(wave.variables.CHANT_RUNNER_IDENTITY).toBeUndefined();
    expect(Object.keys(wave.id_tokens!)).toEqual(["CHANT_ID_TOKEN_AWS"]);
    const ev = doc["wave-1-dev-evidence"]!;
    expect(ev.needs).toEqual(["wave-1-dev", "wave-1-dev-policy"]);
    expect(ev.allow_failure).toBe(true);
    expect(ev.id_tokens).toEqual({ CHANT_ID_TOKEN_SIGSTORE: { aud: "sigstore" } });
    expect(JSON.parse(ev.variables.CHANT_EVIDENCE_SOURCES!)).toEqual({ "plan:dev": {}, "policy:dev": { job: "wave-1-dev-policy" } });
    expect(ev.script.join("\n")).toContain('git checkout --quiet --detach "$CHANT_EVIDENCE_BASE"');
    expect(ev.script.at(-1)).toBe('chant ci evidence sign --from-job wave-1-dev --check-id plan:dev,policy:dev --claims .chant/op-waves/roots/checks --at "$CI_COMMIT_SHA" --base "$CHANT_EVIDENCE_BASE"');
  });

  test("a later wave signs its plan in its own job, and waits for the evidence its evidence.requires names", () => {
    const doc = docOf(spec, { identity: "oidc" });
    const prod = doc["wave-2-prod"]!;
    expect(prod.variables).toMatchObject({ CHANT_RUNNER_IDENTITY: "oidc", CHANT_WAVE_EVIDENCE: "plan" });
    expect(prod.needs).toEqual(["wave-1-dev", "wave-2-prod-policy", "wave-1-dev-evidence"]);
    expect(doc["wave-2-prod-evidence"]!.script.at(-1)).toContain("--check-id policy:prod ");
  });

  test("without a policy or a keyless cloud trade there is no policy or evidence job", () => {
    const plain: OpWavesSpec = { ...spec, holds: undefined, waves: [{ name: "dev", runs: [{ target: "network" }] }] };
    const doc = docOf(plain, { identity: "oidc" });
    expect(Object.keys(doc).filter((k) => k.startsWith("wave-"))).toEqual(["wave-1-dev"]);
  });
});
