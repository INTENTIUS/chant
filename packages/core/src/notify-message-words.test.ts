/**
 * Slack and Teams messages a product can word (#4818): labels, a drift
 * notice's re-run button, and the relay's name in the Teams reply.
 *
 * Two proofs. With no words, every message is the bytes chant 0.124.77
 * rendered (`__fixtures__/notify-messages/messages.json`). With terragucci's
 * words, chant's messages are the bytes terragucci's own renderers write
 * (`__fixtures__/terragucci-notify.ts`, copied from terragucci), over the
 * notices terragucci's notify tests build.
 */
import { describe, expect, test } from "vitest";
import { makeNotifyEvent, sendNotify, slackMessage, teamsMessage, type NotifyEvent, type NotifyFetch, type NotifyMessageWords } from "./notify";
import { driftNotifyFields, NOTIFY_MESSAGE_WORDS_FLOOR, productSendOptions } from "./notify-product";
import { assertProductWords } from "./ci-product-words";
import { NEXT_RELEASE } from "./release-floors";
import { NOTIFY_MESSAGE_EVENTS } from "./__fixtures__/notify-messages/events";
import recorded from "./__fixtures__/notify-messages/messages.json";
import * as tg from "./__fixtures__/terragucci-notify";
import schema from "./notify.schema.json";
import { contract } from "./workspace/__fixtures__/contract-repo";

const { expectValid } = contract(schema);
const NOW = new Date("2026-11-08T12:00:00.000Z");
const relay = { token: "signed-ref" };

describe("a message given no words (#4818)", () => {
  test.each(Object.keys(NOTIFY_MESSAGE_EVENTS))("%s is the bytes chant 0.124.77 wrote, with and without relay buttons", (key) => {
    const e = NOTIFY_MESSAGE_EVENTS[key]!;
    const want = (recorded as Record<string, Record<string, string>>)[key]!;
    for (const words of [undefined, {}]) {
      expect(JSON.stringify(slackMessage(e, undefined, words))).toBe(want.slack);
      expect(JSON.stringify(teamsMessage(e, undefined, words))).toBe(want.teams);
      expect(JSON.stringify(slackMessage(e, relay, words))).toBe(want.slackRelay);
      expect(JSON.stringify(teamsMessage(e, relay, words))).toBe(want.teamsRelay);
    }
  });

  test("chant's words, and a product's words with no message slot, leave sendNotify's options as they were", () => {
    expect(productSendOptions(assertProductWords({}), { attempts: 1 })).toEqual({ attempts: 1 });
    expect(productSendOptions(assertProductWords({ product: "plywood", noun: ["stack", "stacks"] }))).toEqual({ prefix: "x-plywood" });
  });
});

// ── terragucci ───────────────────────────────────────────────────────────

/** terragucci's message words, as it would pass them in its CiProductWords' notify slot. */
const TERRAGUCCI_MESSAGE: NotifyMessageWords = {
  targets: "Roots",
  noTargets: "see the run",
  reason: "Outcome",
  again: "run the wave again",
  wave: "Wave",
  teamsReport: false,
  rerun: { label: "Re-plan", action: "terragucci-replan", block: "terragucci-drift" },
};
const words = assertProductWords({ product: "terragucci", noun: ["root", "roots"], notify: { source: "terragucci", wave: "wave {k}", headers: "x-terragucci", message: TERRAGUCCI_MESSAGE } });

/** The chat event for a wave notice: what terragucci's messages show, as chant's event fields. */
function waveEvent(n: tg.WaveNotice): NotifyEvent {
  return makeNotifyEvent(
    {
      source: "terragucci",
      event: n.event,
      summary: tg.summary(n),
      project: n.project,
      wave: { number: n.wave, gate: `wave-${n.wave}` },
      targets: n.roots,
      ...(n.digest ? { digest: n.digest } : {}),
      approve: { command: n.approve, ...(n.review ? { review: n.review } : {}) },
      ...(n.outcome ? { reason: n.outcome } : {}),
      run: n.run ? { url: n.run } : {},
      ...(n.report ? { reportUrl: n.report } : {}),
    },
    { env: {}, now: NOW },
  );
}

/** The drift event: chant's drift fields under terragucci's words, its headline as the summary, and the Re-plan page. */
function driftEvent(n: tg.DriftNotice): NotifyEvent {
  const fields = driftNotifyFields(words, { changed: n.roots, failed: n.failed, project: n.project, ...(n.report ? { reportUrl: n.report } : {}) });
  return makeNotifyEvent({ ...fields, summary: tg.driftHeadline(n).slice("terragucci: ".length), ...(n.replan ? { rerunUrl: n.replan } : {}), run: n.run ? { url: n.run } : {} }, { env: {}, now: NOW });
}

// The notices terragucci's test/notify.test.ts builds (ENV is acme/infra, run 42).
const RUN = "https://github.com/acme/infra/actions/runs/42";
const PROJECT = "github.com/acme/infra";
const waiting: tg.WaveNotice = { event: "waiting", wave: 2, project: PROJECT, roots: ["envs/prod/app", "envs/prod/db"], approve: "npx terragucci approve wave-2 --plan jcs1-sha256:ab", digest: "jcs1-sha256:ab", run: RUN };
const WAVES: Record<string, tg.WaveNotice> = {
  waiting,
  "waiting with a report": { ...waiting, report: "https://reports.example/acme/42" },
  "under pr-review": { ...waiting, review: { pr: 7, url: "https://github.com/acme/infra/pull/7/files" } },
  "waiting with the relay": { ...waiting, relay: "terragucci" },
  refused: { event: "refused", wave: 3, project: PROJECT, roots: ["envs/prod/app"], approve: "read the plans that moved, then npx terragucci approve wave-3 --plan jcs1-sha256:dd, or revert", outcome: "wave 3 changed after approval: envs/prod/app", run: RUN },
  "failed, no roots": { event: "failed", wave: 1, project: "this project", roots: [], approve: "nothing to approve: the apply failed; read the job log" },
  "failed, policy denied": { event: "failed", wave: 1, project: PROJECT, roots: ["envs/prod/app"], approve: "nothing to approve: the policy denied it; an override command is in the job log", outcome: "policy denied envs/prod/app", run: RUN, report: "https://reports.example/acme/43" },
};
const DRIFTS: Record<string, tg.DriftNotice> = {
  "drift with a Re-plan page": { project: PROJECT, roots: ["app"], failed: ["db"], run: RUN, replan: "https://github.com/acme/infra/actions/workflows/terragucci.yml" },
  "drift on GitLab, with a report": { project: "acme/infra", roots: ["app", "net"], failed: [], run: "https://gitlab.com/acme/infra/-/jobs/9", report: "https://reports.example/acme/44", replan: "https://gitlab.com/acme/infra/-/pipeline_schedules" },
  "drift with no Re-plan page": { project: PROJECT, roots: [], failed: ["db"] },
};

describe("terragucci's messages, rendered by chant under its words (#4818)", () => {
  test.each(Object.keys(WAVES))("a wave %s: Slack and Teams are terragucci's bytes", (key) => {
    const n = WAVES[key]!;
    const e = waveEvent(n);
    const message = { ...TERRAGUCCI_MESSAGE, ...(n.relay ? { relayName: n.relay } : {}) };
    expect(JSON.stringify(slackMessage(e, undefined, message))).toBe(JSON.stringify(tg.slackMessage(n)));
    expect(JSON.stringify(teamsMessage(e, undefined, message))).toBe(JSON.stringify(tg.teamsMessage(n)));
    if (n.relay) {
      expect(JSON.stringify(slackMessage(e, relay, message))).toBe(JSON.stringify(tg.slackMessage(n, relay)));
      expect(JSON.stringify(teamsMessage(e, relay, message))).toBe(JSON.stringify(tg.teamsMessage(n, relay)));
    }
  });

  test.each(Object.keys(DRIFTS))("%s: Slack and Teams are terragucci's bytes", (key) => {
    const n = DRIFTS[key]!;
    const e = driftEvent(n);
    expect(JSON.stringify(slackMessage(e, undefined, TERRAGUCCI_MESSAGE))).toBe(JSON.stringify(tg.slackDrift(n)));
    expect(JSON.stringify(teamsMessage(e, undefined, TERRAGUCCI_MESSAGE))).toBe(JSON.stringify(tg.teamsDrift(n)));
  });

  test("terragucci's test lines hold: the review line, the relay reply, the Re-plan button", () => {
    const review = slackMessage(waveEvent(WAVES["under pr-review"]!), undefined, TERRAGUCCI_MESSAGE).text.split("\n");
    expect(review[1]).toBe("Review and approve: <https://github.com/acme/infra/pull/7/files|pull request 7>, then run the wave again");
    const card = (teamsMessage(waveEvent(WAVES["waiting with the relay"]!), relay, { ...TERRAGUCCI_MESSAGE, relayName: "terragucci" }) as any).attachments[0].content;
    expect(card.body.at(-1).text).toBe("Approve here: reply @terragucci approve signed-ref. Decline: reply @terragucci decline signed-ref.");
    const n = DRIFTS["drift with a Re-plan page"]!;
    const slack = slackMessage(driftEvent(n), undefined, TERRAGUCCI_MESSAGE);
    expect(slack.text.split("\n")).toEqual(["*terragucci: drift in github.com/acme/infra: 1 root changed outside Terraform, 1 could not be refreshed*", "Drifted: app", "Not refreshed: db", `Run: <${RUN}>`]);
    expect((slack.blocks?.[1] as any).elements).toEqual([{ type: "button", action_id: "terragucci-replan", text: { type: "plain_text", text: "Re-plan" }, url: n.replan }]);
  });

  test("sendNotify posts terragucci's drift bodies with the words and no render of its own", async () => {
    const n = DRIFTS["drift with a Re-plan page"]!;
    const posted: Record<string, string> = {};
    const fetch: NotifyFetch = async (url, init) => {
      posted[url] = init.body;
      return { ok: true, status: 200 };
    };
    const env = { S: "https://hooks.slack.test/a", T: "https://teams.test/b" };
    const out = await sendNotify({ slack: "S", teams: "T" }, driftEvent(n), productSendOptions(words, { env, fetch, attempts: 1 }));
    expect(out.map((d) => d.ok)).toEqual([true, true]);
    expect(posted[env.S]).toBe(JSON.stringify(tg.slackDrift(n)));
    expect(posted[env.T]).toBe(JSON.stringify(tg.teamsDrift(n)));
  });

  test("sendNotify names the relay in the Teams reply from its message options", async () => {
    const n = WAVES["waiting with the relay"]!;
    const posted: string[] = [];
    const fetch: NotifyFetch = async (_url, init) => {
      posted.push(init.body);
      return { ok: true, status: 200 };
    };
    const options = productSendOptions(words, { env: { T: "https://teams.test/b", RK: "k" }, fetch, attempts: 1, message: { relayName: "terragucci" } });
    await sendNotify({ teams: "T", relay: "RK" }, waveEvent(n), options);
    const card = JSON.parse(posted[0]!).attachments[0].content;
    expect(card.body.at(-1).text).toMatch(/^Approve here: reply @terragucci approve \S+\. Decline: reply @terragucci decline \S+\.$/);
    expect(card.body[1].facts[0]).toEqual({ title: "Wave", value: "2" });
  });
});

describe("chant's own words for the re-run button and the relay (#4818)", () => {
  const drift = NOTIFY_MESSAGE_EVENTS.drift!;
  const e = { ...drift, rerunUrl: "https://github.com/acme/db/actions/workflows/drift.yml" };

  test("a re-run page gives a Slack button and a Teams action before the run's", () => {
    const slack = slackMessage(e);
    expect(slack.blocks?.[1]).toEqual({ type: "actions", elements: [{ type: "button", action_id: "chant-rerun", text: { type: "plain_text", text: "Run again" }, url: e.rerunUrl }] });
    const card = (teamsMessage(e) as any).attachments[0].content;
    expect(card.actions).toEqual([
      { type: "Action.OpenUrl", title: "Run again", url: e.rerunUrl },
      { type: "Action.OpenUrl", title: "Open the run", url: drift.run!.url },
    ]);
    expectValid(JSON.parse(JSON.stringify(e)));
  });

  test("the relay's name turns the Teams fact into the full replies", () => {
    const waitingEvent = NOTIFY_MESSAGE_EVENTS.waiting!;
    const card = (teamsMessage(waitingEvent, relay, { relayName: "chant-relay" }) as any).attachments[0].content;
    expect(card.body[1].facts.map((f: { title: string }) => f.title)).not.toContain("Approve in chat");
    expect(card.body[2]).toEqual({ type: "TextBlock", wrap: true, text: "Approve here: reply @chant-relay approve signed-ref. Decline: reply @chant-relay decline signed-ref." });
  });

  test("the floor names the next release", () => expect(NOTIFY_MESSAGE_WORDS_FLOOR).toBe(NEXT_RELEASE));
});
