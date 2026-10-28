/** #4631: a GitLab scheduled Op job trades first, and an update on drift is a job of its own on the run's dotenv. */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";

interface Job { needs?: unknown; rules?: Array<Record<string, unknown>>; id_tokens?: Record<string, { aud: string }>; variables?: Record<string, string>; script: string[]; artifacts?: Record<string, unknown> }

const PREVIEW = { aws: { role: "arn:aws:iam::1:role/preview", region: "us-east-1", audience: "sts.amazonaws.com" } };
const UPDATE = { aws: { role: "arn:aws:iam::1:role/update", region: "us-east-1", audience: "sts.amazonaws.com" } };
const spec: ScheduledOpSpec = { name: "drift-dev", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue", cloud: PREVIEW, update: { command: "plywood up", cloud: UPDATE } };

describe("cloud identities on a GitLab scheduled Op (#4631)", () => {
  const doc = parseYAML(generateGitlabOpPipeline([spec]).files[0]!.yaml) as unknown as Record<string, Job>;
  const check = doc["drift-dev"]!;
  const update = doc["drift-dev-update"]!;

  test("the check's script trades first and unsets the token variables, with an id token per cloud", () => {
    expect(check.id_tokens).toEqual({ CHANT_ID_TOKEN_AWS: { aud: "sts.amazonaws.com" } });
    expect(JSON.parse(check.variables!.CHANT_CLOUD_TRADE!)).toEqual(PREVIEW);
    expect(check.script[0]).toContain("node -e");
    expect(check.script[1]).toMatch(/^unset .*CHANT_ID_TOKEN_AWS/);
    expect(check.script.join("\n")).toContain('echo "CHANT_AGENT_DRIFT=1"');
    expect(check.artifacts).toMatchObject({ reports: { dotenv: ".chant/agent/drift.env" } });
    expect(JSON.stringify(check)).not.toContain("role/update");
  });

  test("the update job needs the check, stops with no drift, and trades for its own identity", () => {
    expect(update.needs).toEqual([{ job: "drift-dev", artifacts: true }]);
    expect(update.rules!.every((r) => r.when === "always")).toBe(true);
    expect(update.script[0]).toContain('"${CHANT_AGENT_DRIFT:-0}" != "1"');
    expect(JSON.parse(update.variables!.CHANT_CLOUD_TRADE!)).toEqual(UPDATE);
    expect(update.script.at(-1)).toBe("plywood up");
  });

  test("update.permissions has no GitLab form", () => {
    expect(() => generateGitlabOpPipeline([{ ...spec, update: { command: "x", permissions: { issues: "write" } } }])).toThrow(/no GitLab form/);
  });
});
