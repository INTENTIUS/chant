/**
 * #4631: cloud identities on a scheduled Op's job, traded before the
 * checkout, and an update on drift in a job of its own that alone holds
 * the update's identity.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateGithubOpPipeline } from "./generate-op-pipeline";

interface Step { id?: string; name?: string; uses?: string; run?: string; env?: Record<string, string> }
interface Job { needs?: string; if?: string; permissions?: Record<string, string>; outputs?: Record<string, string>; environment?: unknown; steps: Step[] }
interface Doc { permissions?: Record<string, string>; jobs: Record<string, Job> }

const PREVIEW = { aws: { role: "arn:aws:iam::1:role/preview", region: "us-east-1", audience: "sts.amazonaws.com" } };
const UPDATE = { aws: { role: "arn:aws:iam::1:role/update", region: "us-east-1", audience: "sts.amazonaws.com" } };
const DRIFT: ScheduledOpSpec = { name: "plywood-drift-dev", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue", cloud: PREVIEW };

const gen = (spec: ScheduledOpSpec) => parseYAML(generateGithubOpPipeline([spec]).files[0]!.yaml) as unknown as Doc;

describe("a scheduled Op's cloud identities (#4631)", () => {
  test("the trade runs before the checkout, and every later run step drops the token request variables", () => {
    const doc = gen(DRIFT);
    const job = doc.jobs["plywood-drift-dev"]!;
    expect(job.steps[0]!.name).toBe("Trade the job's OIDC token for its cloud identities");
    expect(JSON.parse(job.steps[0]!.env!.CHANT_CLOUD_TRADE!)).toEqual(PREVIEW);
    expect(job.steps[1]!.uses).toMatch(/^actions\/checkout@/);
    for (const step of job.steps.slice(2)) if (step.run) expect(step.run).toMatch(/^unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL/);
  });

  test("the finding-mode's permissions stay; the job alone adds id-token: write", () => {
    const plain = gen({ ...DRIFT, cloud: undefined } as ScheduledOpSpec);
    const doc = gen(DRIFT);
    expect(doc.permissions).toEqual(plain.permissions);
    expect(doc.jobs["plywood-drift-dev"]!.permissions).toEqual({ ...plain.permissions, "id-token": "write" });
  });

  test("a malformed cloud and a cloud on a review split are refused", () => {
    expect(() => gen({ ...DRIFT, cloud: { aws: { region: "us-east-1" } } as never })).toThrow(/audience/);
    expect(() => gen({ name: "review", trigger: { kind: "pull_request" }, reviewAgent: true, cloud: PREVIEW })).toThrow(/no cloud identity/);
  });
});

describe("an update on drift (#4631)", () => {
  const spec: ScheduledOpSpec = { ...DRIFT, update: { command: "npx --no-install plywood up", cloud: UPDATE, environment: { name: "production" } } };
  const doc = gen(spec);
  const check = doc.jobs["plywood-drift-dev"]!;
  const update = doc.jobs["plywood-drift-dev-update"]!;

  test("the check says when it found drift, and holds only its own identity", () => {
    expect(check.outputs).toEqual({ drift: "${{ steps.drift-check.outputs.drift }}" });
    const run = check.steps.find((s) => s.id === "drift-check")!;
    expect(run.run).toContain('if [ "$code" -eq 2 ]; then echo "drift=true"');
    expect(JSON.stringify(check)).not.toContain("role/update");
  });

  test("the update job runs after a drift, trades for its own identity first, and runs the command", () => {
    expect(update.needs).toBe("plywood-drift-dev");
    expect(update.if).toBe("always() && needs.plywood-drift-dev.outputs.drift == 'true'");
    expect(update.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(update.environment).toEqual({ name: "production" });
    expect(JSON.parse(update.steps[0]!.env!.CHANT_CLOUD_TRADE!)).toEqual(UPDATE);
    expect(update.steps[1]!.uses).toMatch(/^actions\/checkout@/);
    expect(update.steps.at(-1)!.run).toMatch(/^unset .*\nnpx --no-install plywood up\n?$/);
  });

  test("an update on a push trigger, or with no command, is refused", () => {
    expect(() => gen({ name: "apply", trigger: { kind: "push" }, update: { command: "x" } })).toThrow(/cron or pull_request/);
    expect(() => gen({ ...DRIFT, update: { command: " " } })).toThrow(/command/);
  });
});

describe("contents: write on the update job (#4631, 2026-10-28 ruling)", () => {
  const plain = gen(DRIFT);
  const spec: ScheduledOpSpec = { ...DRIFT, update: { command: "npx --no-install plywood up", cloud: UPDATE, permissions: { contents: "write" } } };
  const doc = gen(spec);

  test("the update job may raise contents to write, so it records on chant/lifecycle", () => {
    expect(doc.jobs["plywood-drift-dev-update"]!.permissions).toEqual({ contents: "write", "id-token": "write" });
  });

  test("the drift check's job and the workflow keep their scopes", () => {
    expect(doc.permissions).toEqual(plain.permissions);
    expect(doc.jobs["plywood-drift-dev"]!.permissions).toEqual(plain.jobs["plywood-drift-dev"]!.permissions);
    expect(doc.jobs["plywood-drift-dev"]!.permissions!.contents).not.toBe("write");
  });

  test("the identity scoping stays: the check holds the preview identity, the update its own", () => {
    expect(JSON.stringify(doc.jobs["plywood-drift-dev"])).not.toContain("role/update");
    expect(JSON.parse(doc.jobs["plywood-drift-dev-update"]!.steps[0]!.env!.CHANT_CLOUD_TRADE!)).toEqual(UPDATE);
  });

  test("contents restated at read is still refused", () => {
    expect(() => gen({ ...DRIFT, update: { command: "x", permissions: { contents: "read" } } })).toThrow(/contents may only be raised to write/);
  });
});
