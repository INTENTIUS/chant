import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { verifyWebhook, type NotifyEvent, type NotifyFetch } from "../notify";
import { memoryGateLedgerPort } from "./gate";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { notifyOpWave, opWaveNotifyFields } from "./op-waves-notify";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";

const spec: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "prod", runs: [{ target: "t2" }, { target: "t1" }], shares: 2 },
  ],
  notify: { webhook: "CHANT_WEBHOOK", key: "CHANT_WEBHOOK_KEY", slack: "CHANT_SLACK_WEBHOOK" },
};
const env = { CHANT_WEBHOOK: "https://hooks.example/chant", CHANT_WEBHOOK_KEY: "k", CHANT_SLACK_WEBHOOK: "https://hooks.slack.com/services/x", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/db", GITHUB_RUN_ID: "7" };
const digest = (n: string) => `sha256:${n.repeat(64)}`;

function harness(plans: Record<string, { planDigest: string }>, failApply = false) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-notify-"));
  const exec: OpWaveExec = (argv, dir) => {
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify(plans[argv[2]!]));
    return argv[1] === "apply" && failApply ? 2 : 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  return { cwd, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

function recorder(status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetch: NotifyFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: status < 300, status };
  };
  return { calls, fetch };
}

describe("an Op waves job's notify", () => {
  test("a waiting wave sends the approve command, the digest, the targets and the run, signed", async () => {
    const h = harness({ t1: { planDigest: digest("1") }, t2: { planDigest: digest("2") } });
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 2, decide: true, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: () => {} });
    h.done();
    expect(result.exitCode).toBe(3);
    const { calls, fetch } = recorder();
    const out = await notifyOpWave(spec, 2, { result }, {}, { env, fetch, sleep: async () => {}, log: () => {} });
    expect(out.map((d) => d.ok)).toEqual([true, true]);
    const event = JSON.parse(calls[0]!.body) as NotifyEvent;
    expect(event).toMatchObject({
      schema: "chant.notify/v1",
      source: "chant",
      event: "waiting",
      project: "acme/db",
      summary: "wave 2 (prod) of migrations waits for an approval",
      wave: { number: 2, name: "prod", gate: "migrations-wave-2" },
      targets: ["t2", "t1"],
      digest: result.decision!.digest,
      approve: { command: result.decision!.approve },
      exitCode: 3,
      run: { url: "https://github.com/acme/db/actions/runs/7" },
    });
    expect(event.approve!.command).toMatch(/^chant approve migrations migrations-wave-2 --plan (jcs1-)?sha256:/);
    expect(verifyWebhook({ body: calls[0]!.body, headers: calls[0]!.headers, key: "k" }).ok).toBe(true);
    expect(JSON.parse(calls[1]!.body).text).toContain("Approve: `chant approve migrations migrations-wave-2");
  });

  test("a share job of a waiting wave sends nothing; its deciding job did", () => {
    const decision = { wave: 2, name: "prod", op: "migrations", gate: "migrations-wave-2", policy: "always" as const, approval: "ledger" as const, policySource: "base" as const, base: "b", digest: digest("d"), members: [], status: "waiting" as const };
    expect(opWaveNotifyFields(spec, 2, { result: { exitCode: 3, decision, applied: [], failed: [], moved: [], hooks: [] } }, { share: 1 })).toBeUndefined();
    expect(opWaveNotifyFields(spec, 2, { result: { exitCode: 0, applied: ["t1"], failed: [], moved: [], hooks: [] } })).toBeUndefined();
  });

  test("a share job held by its own hook sends waiting, and a failed hook is named (#3762)", () => {
    const decision = { wave: 2, name: "prod", op: "migrations", gate: "migrations-wave-2", policy: "always" as const, approval: "ledger" as const, policySource: "base" as const, base: "b", digest: digest("d"), members: [], status: "waiting" as const, heldBy: ["smoke"], approve: "chant approve migrations migrations-wave-2 --plan x" };
    const held = { moment: "before-apply" as const, name: "smoke", exit: 2, outcome: "held" as const };
    expect(opWaveNotifyFields(spec, 2, { result: { exitCode: 3, decision, applied: [], failed: [], moved: [], hooks: [held] } }, { share: 1 })).toMatchObject({ event: "waiting", reason: "held by smoke" });
    const broke = { moment: "after-apply" as const, name: "verify", exit: 1, outcome: "failed" as const };
    expect(opWaveNotifyFields(spec, 1, { result: { exitCode: 1, applied: ["dev"], failed: [], moved: [], hooks: [broke] } })).toMatchObject({
      event: "failed",
      summary: "wave 1 (dev) of migrations failed: after-apply hook verify failed",
    });
  });

  test("a share that refused a moved plan sends refused, and a failed apply sends failed", () => {
    expect(opWaveNotifyFields(spec, 2, { result: { exitCode: 4, applied: ["t1"], failed: [], moved: ["t2"], hooks: [] } }, { share: 1 })).toMatchObject({
      event: "refused",
      summary: "wave 2 (prod) of migrations, share 1, refused 1 run whose plan moved since the wave was decided",
      targets: ["t2"],
      exitCode: 4,
    });
    expect(opWaveNotifyFields(spec, 1, { result: { exitCode: 1, applied: [], failed: ["dev"], moved: [], hooks: [] } })).toMatchObject({
      event: "failed",
      summary: "wave 1 (dev) of migrations failed: dev did not apply",
      targets: ["dev"],
    });
    expect(opWaveNotifyFields(spec, 1, { error: "planning dev exited 2" })).toMatchObject({ event: "failed", reason: "planning dev exited 2", exitCode: 1 });
  });

  test("a failed apply's exit code stays 1 when every delivery fails", async () => {
    const h = harness({ dev: { planDigest: digest("1") } }, true);
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: () => {} });
    h.done();
    const { fetch } = recorder(500);
    const lines: string[] = [];
    const out = await notifyOpWave(spec, 1, { result }, {}, { env, fetch, sleep: async () => {}, log: (l) => lines.push(l) });
    expect(result.exitCode).toBe(1);
    expect(out.every((d) => !d.ok)).toBe(true);
    expect(lines).toEqual([
      "notify: the failed event was not delivered to the webhook: HTTP 500",
      "notify: the failed event was not delivered to Slack: HTTP 500",
    ]);
  });

  test("the spec refuses a URL where a variable name goes, and such a spec sends nothing", async () => {
    const bad = { ...spec, notify: { slack: "https://hooks.slack.com/services/x" } };
    expect(() => assertOpWavesSpec(bad)).toThrow(/Op waves "migrations": notify\.slack: the name of the environment variable/);
    const { calls, fetch } = recorder();
    expect(await notifyOpWave(bad, 1, { error: "x" }, {}, { env, fetch })).toEqual([]);
    expect(calls).toEqual([]);
    expect(await notifyOpWave({ ...spec, notify: undefined }, 1, { error: "x" }, {}, { env, fetch })).toEqual([]);
  });
});
