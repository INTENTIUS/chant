/**
 * #4610: an op-wave job's notify takes its source, its summary words and
 * its header prefix from the active product's words, and chant's own words
 * send what they sent before.
 */
import { afterEach, describe, expect, test } from "vitest";
import { assertProductWords, CHANT_WORDS, notifyWaveLabel, productWordsProblems, resolveProductWords, setActiveProductWords } from "../ci-product-words";
import { makeNotifyEvent, slackMessage, teamsMessage, verifyWebhook, type NotifyFetch, type NotifyFields } from "../notify";
import { driftNotifyFields, productSendOptions } from "../notify-product";
import type { OpWavesSpec } from "./op-waves";
import { notifyOpWave, opWaveNotifyFields, type OpWaveOutcome } from "./op-waves-notify";

const spec: OpWavesSpec = {
  name: "pulumi-up",
  op: "pulumi-up",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "dev", runs: [{ target: "shop-dev" }], gate: "never" }, { name: "prod", runs: [{ target: "shop-prod" }, { target: "shop-eu" }] }],
  notify: { webhook: "HOOK", key: "HOOK_KEY", slack: "SLACK" },
};
const env = { HOOK: "http://127.0.0.1:9/hook", HOOK_KEY: "k", SLACK: "http://127.0.0.1:9/slack" };
const digest = `sha256:${"d".repeat(64)}`;

const PLYWOOD = assertProductWords({
  product: "plywood",
  stages: { plan: "preview", apply: "up" },
  verbs: { plan: ["preview", "previewed"], apply: ["update", "updated"] },
  noun: ["stack", "stacks"],
  approve: "plywood approve {gate} --plan {digest} {sign}",
  op: "pulumi-up",
  prGate: "up",
  gateName: "wave-{k}",
});
const YODEL = assertProductWords({ product: "yodel", noun: ["environment", "environments"], notify: { source: "sql-yodeler" } });

const decision = {
  wave: 2,
  op: "pulumi-up",
  gate: "wave-2",
  policy: "always" as const,
  approval: "ledger" as const,
  policySource: "base" as const,
  base: "b",
  digest,
  members: [{ member: "shop-prod" }, { member: "shop-eu" }],
  status: "waiting" as const,
};

/** One outcome per event kind a wave job sends, and the drift event a product sends. */
const outcomes: Record<string, OpWaveOutcome> = {
  waiting: { result: { exitCode: 3, decision, applied: [], failed: [], moved: [], hooks: [] } as never },
  refused: { result: { exitCode: 4, applied: ["shop-prod"], failed: [], moved: ["shop-eu"], hooks: [] } as never },
  held: { result: { exitCode: 5, decision, applied: [], failed: [], moved: [], hooks: [], outcome: { outcome: "held", holder: { run: "r9" } } } as never },
  failed: { result: { exitCode: 1, applied: [], failed: ["shop-eu"], moved: [], hooks: [] } as never },
  error: { error: "planning shop-dev exited 2" },
};

function recorder() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetch: NotifyFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  return { calls, fetch };
}

afterEach(() => {
  setActiveProductWords(undefined);
});

describe("notify words (#4610)", () => {
  test("chant's own words send what chant sent before, for every event kind", () => {
    const fields = (o: OpWaveOutcome, k = 2) => opWaveNotifyFields(spec, k, o, {}, CHANT_WORDS);
    expect(fields(outcomes.waiting!)).toMatchObject({ source: "chant", summary: "wave 2 (prod) of pulumi-up waits for an approval" });
    expect(fields(outcomes.waiting!)!.approve).not.toHaveProperty("chant");
    expect(fields(outcomes.refused!)).toMatchObject({ source: "chant", summary: "wave 2 (prod) of pulumi-up refused 1 run whose plan moved since the wave was decided" });
    expect(fields(outcomes.held!)).toMatchObject({ source: "chant", summary: "wave 2 (prod) of pulumi-up applied nothing: another run (r9) holds what it changes" });
    expect(fields(outcomes.failed!)).toMatchObject({ source: "chant", summary: "wave 2 (prod) of pulumi-up failed: shop-eu did not apply", reason: "the apply command failed for shop-eu" });
    expect(fields(outcomes.error!, 1)).toMatchObject({ source: "chant", summary: "wave 1 (dev) of pulumi-up failed" });
    // The default argument is the active words, chant's unless a bin set them.
    expect(opWaveNotifyFields(spec, 2, outcomes.failed!)).toEqual(fields(outcomes.failed!));
  });

  test("a product's words set the source and the summary's verbs for every event kind", () => {
    const fields = (o: OpWaveOutcome, k = 2) => opWaveNotifyFields(spec, k, o, {}, PLYWOOD);
    expect(fields(outcomes.waiting!)).toMatchObject({ source: "plywood", summary: "wave 2 (prod) of pulumi-up waits for an approval", approve: { chant: `chant approve pulumi-up wave-2 --plan ${digest}` } });
    expect(fields(outcomes.refused!)).toMatchObject({ source: "plywood", event: "refused" });
    expect(fields(outcomes.held!)).toMatchObject({ source: "plywood", summary: "wave 2 (prod) of pulumi-up updated nothing: another run (r9) holds what it changes" });
    expect(fields(outcomes.failed!)).toMatchObject({ source: "plywood", summary: "wave 2 (prod) of pulumi-up failed: shop-eu did not update", reason: "the update command failed for shop-eu" });
    expect(fields(outcomes.error!, 1)).toMatchObject({ source: "plywood", event: "failed", summary: "wave 1 (dev) of pulumi-up failed" });
    expect(driftNotifyFields(PLYWOOD, { changed: ["shop-dev", "shop-prod"], fingerprint: "fp" })).toMatchObject({
      source: "plywood",
      event: "drift",
      summary: "2 stacks drifted: shop-dev, shop-prod",
      drift: { changed: ["shop-dev", "shop-prod"], fingerprint: "fp" },
    });
    expect(driftNotifyFields(CHANT_WORDS, { changed: ["net"], failed: ["db"] }).summary).toBe("1 member drifted: net; 1 member could not be refreshed: db");
  });

  test("sql-yodeler's words keep source sql-yodeler while its product word is yodel", () => {
    expect(YODEL.notify).toEqual({ source: "sql-yodeler", wave: "wave {k} ({name}) of {spec}", headers: "x-yodel" });
    expect(opWaveNotifyFields(spec, 2, outcomes.failed!, {}, YODEL)).toMatchObject({ source: "sql-yodeler" });
    expect(driftNotifyFields(YODEL, { changed: ["prod"] })).toMatchObject({ source: "sql-yodeler", summary: "1 environment drifted: prod" });
  });

  test("the wave label is a template, and a wave with no name drops its part", () => {
    const words = resolveProductWords({ product: "yodel", notify: { wave: "{product} wave {k} ({name}) of {spec}" } });
    expect(notifyWaveLabel(words, { k: 1, name: "dev", spec: "migrate" })).toBe("yodel wave 1 (dev) of migrate");
    expect(notifyWaveLabel(words, { k: 2, spec: "migrate" })).toBe("yodel wave 2 of migrate");
    expect(notifyWaveLabel(CHANT_WORDS, { k: 2, spec: "tf-apply" })).toBe("wave 2 of tf-apply");
  });

  test("notify words that a receiver could not route or verify on are refused", () => {
    const problems = productWordsProblems(resolveProductWords({ notify: { source: "SQL Yodeler", headers: "yodel", wave: "wave {n}\n" } }));
    expect(problems.some((p) => /notify.source is "SQL Yodeler"/.test(p))).toBe(true);
    expect(problems.some((p) => /notify.headers is "yodel"/.test(p))).toBe(true);
    expect(problems.some((p) => /notify.wave names \{n\}/.test(p))).toBe(true);
    expect(problems.some((p) => /notify.wave needs \{k\}/.test(p))).toBe(true);
    expect(problems.some((p) => /notify.wave is one line/.test(p))).toBe(true);
  });

  test("a wave job under a product's bin signs with the product's headers, and Slack shows the same summary", async () => {
    setActiveProductWords(PLYWOOD);
    const { calls, fetch } = recorder();
    const out = await notifyOpWave(spec, 2, outcomes.waiting!, {}, { env, fetch, sleep: async () => {}, log: () => {} });
    expect(out.map((d) => d.ok)).toEqual([true, true]);
    const hook = calls[0]!;
    expect(hook.headers["x-plywood-signature"]).toMatch(/^sha256=/);
    expect(hook.headers["user-agent"]).toBe("plywood");
    expect(verifyWebhook({ body: hook.body, headers: hook.headers, key: "k", prefix: "x-plywood" }).ok).toBe(true);
    const event = JSON.parse(hook.body);
    expect(event).toMatchObject({ schema: "chant.notify/v1", source: "plywood", summary: "wave 2 (prod) of pulumi-up waits for an approval" });
    expect(event.approve.command).toBe(`plywood approve wave-2 --plan ${digest}`);
    expect(JSON.parse(calls[1]!.body).text.split("\n")[0]).toBe("*plywood: wave 2 (prod) of pulumi-up waits for an approval*");
  });

  test("chant's words keep x-chant, and a caller's own prefix wins", () => {
    expect(productSendOptions(CHANT_WORDS, { env })).toEqual({ env });
    expect(productSendOptions(PLYWOOD).prefix).toBe("x-plywood");
    expect(productSendOptions(PLYWOOD, { prefix: "x-own" }).prefix).toBe("x-own");
  });

  test("Slack and Teams show the drift summary under the product's source", () => {
    const fields: NotifyFields = driftNotifyFields(PLYWOOD, { changed: ["shop-dev"], project: "acme/shop" });
    const event = makeNotifyEvent(fields, { env: {}, now: new Date(0) });
    expect(slackMessage(event).text.split("\n")[0]).toBe("*plywood: 1 stack drifted: shop-dev*");
    expect(JSON.stringify(teamsMessage(event))).toContain("plywood: 1 stack drifted: shop-dev");
  });
});
