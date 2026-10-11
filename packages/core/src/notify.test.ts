import { describe, expect, test } from "vitest";
import {
  NOTIFY_SCHEMA,
  NOTIFY_SCHEMA_ID,
  ciRun,
  makeNotifyEvent,
  notifyConfigProblem,
  notifyHeadline,
  notifyVariables,
  sendNotify,
  slackMessage,
  teamsMessage,
  verifyWebhook,
  webhookRequest,
  type NotifyEvent,
  type NotifyFetch,
} from "./notify";
import { contract, validSchema } from "./workspace/__fixtures__/contract-repo";
import schema from "./notify.schema.json";

const { expectValid, validate } = contract(schema);
const NOW = new Date("2026-10-11T12:00:00.000Z");
const GITHUB = { GITHUB_ACTIONS: "true", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/db", GITHUB_RUN_ID: "42", GITHUB_SHA: "abc123" };
const DIGEST = "jcs1-sha256:" + "a".repeat(64);

const waiting = (env: NodeJS.ProcessEnv = GITHUB): NotifyEvent =>
  makeNotifyEvent(
    {
      source: "chant",
      event: "waiting",
      summary: "wave 3 (prod) of migrations waits for an approval",
      wave: { number: 3, name: "prod", gate: "migrations-wave-3" },
      targets: ["prod-eu", "prod-us"],
      digest: DIGEST,
      approve: { command: `chant approve migrations migrations-wave-3 --plan ${DIGEST}` },
    },
    { env, now: NOW },
  );

const drift = (): NotifyEvent =>
  makeNotifyEvent(
    { source: "sql-yodeler", event: "drift", summary: "prod drifted: orders changed", environment: "prod", drift: { changed: ["orders"], missing: ["audit_log"], fingerprint: "fp1" } },
    { env: {}, now: NOW },
  );

/** A fetch that records what it was sent and answers from `answers` in turn (the last one repeats). */
function recorder(...answers: Array<number | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetch: NotifyFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)] ?? 200;
    if (a instanceof Error) throw a;
    return { ok: a >= 200 && a < 300, status: a };
  };
  return { calls, fetch };
}

const quiet = { sleep: async () => {}, log: () => {} };

describe("the notify schema", () => {
  test("is a valid draft 2020-12 document whose $id the module names", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(NOTIFY_SCHEMA_ID);
    expect(schema.properties.schema.const).toBe(NOTIFY_SCHEMA);
  });

  test("every event the module makes validates, and a drift event needs its drift", () => {
    expectValid(waiting());
    expectValid(drift());
    expectValid(makeNotifyEvent({ source: "terragucci", event: "refused", summary: "", reason: "plans moved", targets: ["infra/vpc"], exitCode: 4, detail: { schema: "terragucci.outcome/v1" } }, { env: {}, now: NOW }));
    const d = drift();
    delete (d as Partial<NotifyEvent>).drift;
    expect(validate(d)).toBe(false);
    expect(validate({ ...waiting(), event: "applied" })).toBe(false);
    expect(validate({ ...waiting(), schema: "chant.notify/v2" })).toBe(false);
  });
});

describe("makeNotifyEvent", () => {
  test("adds the schema, the time, the CI run and the project", () => {
    const e = waiting();
    expect(e).toMatchObject({ schema: NOTIFY_SCHEMA, at: NOW.toISOString(), project: "acme/db" });
    expect(e.run).toEqual({ url: "https://github.com/acme/db/actions/runs/42", forge: "github", repository: "acme/db", commit: "abc123" });
  });

  test("gives one event about one digest the same id on a re-run, and another event another id", () => {
    expect(waiting().id).toBe(waiting().id);
    expect(waiting().id).toMatch(/^[0-9a-f]{64}$/);
    const refused = makeNotifyEvent({ ...waiting(), event: "refused", id: undefined }, { env: GITHUB });
    expect(refused.id).not.toBe(waiting().id);
    // No digest, fingerprint or commit: random.
    const a = makeNotifyEvent({ source: "chant", event: "failed", summary: "x" }, { env: {} });
    const b = makeNotifyEvent({ source: "chant", event: "failed", summary: "x" }, { env: {} });
    expect(a.id).not.toBe(b.id);
    expect(a.project).toBe("this project");
    expect(a.run).toBeUndefined();
  });

  test("keeps a product's own run fields over the CI's", () => {
    const e = makeNotifyEvent({ source: "terragucci", event: "failed", summary: "", run: { pr: 7, url: "https://ci.example/run/1" } }, { env: GITHUB });
    expect(e.run).toMatchObject({ pr: 7, url: "https://ci.example/run/1", repository: "acme/db" });
  });
});

describe("ciRun", () => {
  test("reads GitLab's job and Forgejo's run", () => {
    expect(ciRun({ GITLAB_CI: "true", CI_JOB_URL: "https://gitlab.example/acme/db/-/jobs/9", CI_PROJECT_PATH: "acme/db", CI_COMMIT_SHA: "def" })).toEqual({
      url: "https://gitlab.example/acme/db/-/jobs/9",
      forge: "gitlab",
      repository: "acme/db",
      commit: "def",
    });
    expect(ciRun({ ...GITHUB, GITHUB_ACTIONS: "true", FORGEJO_ACTIONS: "true" }).forge).toBe("forgejo");
    expect(ciRun({})).toEqual({});
  });
});

describe("the chat messages", () => {
  test("Slack gets the headline, the targets, the digest and the approve command as code, and the run as a link", () => {
    expect(slackMessage(waiting()).text).toBe(
      [
        "*chant: wave 3 (prod) of migrations waits for an approval*",
        "Targets: prod-eu, prod-us",
        `Digest: \`${DIGEST}\``,
        `Approve: \`chant approve migrations migrations-wave-3 --plan ${DIGEST}\``,
        "Run: <https://github.com/acme/db/actions/runs/42>",
      ].join("\n"),
    );
  });

  test("a pr-review wave links the review first, and the command becomes the other way", () => {
    const e = { ...waiting(), approve: { command: "chant approve x", review: { pr: 12, url: "https://github.com/acme/db/pull/12" } } };
    const text = slackMessage(e).text;
    expect(text).toContain("Review and approve: <https://github.com/acme/db/pull/12|pull request 12>, then run it again");
    expect(text).toContain("Or approve: `chant approve x`");
    const card = JSON.stringify(teamsMessage(e));
    expect(card).toContain('"title":"Review and approve","url":"https://github.com/acme/db/pull/12"');
  });

  test("drift shows what changed, what is missing and nothing to approve", () => {
    const text = slackMessage(drift()).text;
    expect(text).toBe("*sql-yodeler: prod drifted: orders changed*\nDrifted: orders\nMissing: audit_log");
  });

  test("Teams gets one Adaptive Card with the facts and a button to the run", () => {
    const m = teamsMessage(waiting()) as { type: string; attachments: Array<{ contentType: string; content: { type: string; body: Array<{ type: string; text?: string; facts?: Array<{ title: string; value: string }> }>; actions?: unknown[] } }> };
    expect(m.type).toBe("message");
    const card = m.attachments[0]!;
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.body[0]!.text).toBe("chant: wave 3 (prod) of migrations waits for an approval");
    expect(card.content.body[1]!.facts!.map((f) => f.title)).toEqual(["Targets", "Digest", "Approve", "Run"]);
    expect(card.content.actions).toEqual([{ type: "Action.OpenUrl", title: "Open the run", url: "https://github.com/acme/db/actions/runs/42" }]);
  });

  test("a headline with no summary says what happened to what", () => {
    expect(notifyHeadline({ ...waiting(), summary: "" })).toBe("chant: wave 3 (prod) of acme/db waits for an approval");
    expect(notifyHeadline({ ...drift(), summary: "" })).toBe("sql-yodeler: prod in this project drifted");
  });
});

describe("notifyConfigProblem", () => {
  test("accepts variable names and refuses URLs, keys, a webhook without its key and unknown settings", () => {
    expect(notifyConfigProblem({ webhook: "HOOK", key: "HOOK_KEY", slack: "SLACK", teams: "TEAMS", events: ["waiting", "drift"] })).toBeUndefined();
    expect(notifyConfigProblem({ slack: "https://hooks.slack.com/services/T/B/x" })).toMatch(/^notify\.slack: the name of the environment variable/);
    expect(notifyConfigProblem({ webhook: "HOOK" })).toMatch(/^notify\.key: a webhook needs a signing key/);
    expect(notifyConfigProblem({ key: "K" })).toMatch(/^notify\.webhook:/);
    expect(notifyConfigProblem({})).toMatch(/name a webhook/);
    expect(notifyConfigProblem({ slack: "S", channel: "#ops" })).toMatch(/^notify\.channel: unknown setting/);
    expect(notifyConfigProblem({ slack: "S", events: ["applied"] })).toMatch(/^notify\.events:/);
    expect(notifyConfigProblem([], "waves.notify")).toMatch(/^waves\.notify: expected/);
  });

  test("notifyVariables lists the variables a pipeline maps its secrets into", () => {
    expect(notifyVariables({ webhook: "HOOK", key: "HOOK_KEY", teams: "TEAMS" })).toEqual(["HOOK", "HOOK_KEY", "TEAMS"]);
    expect(notifyVariables(undefined)).toEqual([]);
  });
});

describe("sendNotify", () => {
  const SECRET_URL = "https://hooks.example/T000/B000/secret-token";
  const env = { HOOK: SECRET_URL, HOOK_KEY: "k3y", SLACK: "https://hooks.slack.com/services/T/B/slack-secret", TEAMS: "https://teams.example/workflows/teams-secret" };

  test("posts the signed event to the webhook and the rendered messages to Slack and Teams", async () => {
    const { calls, fetch } = recorder(200);
    const e = waiting();
    const out = await sendNotify({ webhook: "HOOK", key: "HOOK_KEY", slack: "SLACK", teams: "TEAMS" }, e, { env, fetch, now: 1_760_184_000, ...quiet });
    expect(out).toEqual([
      { target: "webhook", ok: true, detail: "delivered" },
      { target: "slack", ok: true, detail: "delivered" },
      { target: "teams", ok: true, detail: "delivered" },
    ]);
    expect(calls.map((c) => c.url)).toEqual([env.HOOK, env.SLACK, env.TEAMS]);
    const hook = calls[0]!;
    expect(JSON.parse(hook.body)).toEqual(e);
    expect(hook.headers).toMatchObject({ "x-chant-event": "waiting", "x-chant-delivery": e.id, "x-chant-timestamp": "1760184000" });
    expect(verifyWebhook({ body: hook.body, headers: hook.headers, key: "k3y", now: 1_760_184_000 })).toEqual({ ok: true, event: e });
    expect(JSON.parse(calls[1]!.body)).toEqual(slackMessage(e));
    expect(JSON.parse(calls[2]!.body)).toEqual(teamsMessage(e));
  });

  test("never sends an event unsigned", async () => {
    const { calls, fetch } = recorder(200);
    const lines: string[] = [];
    const out = await sendNotify({ webhook: "HOOK", key: "HOOK_KEY" }, waiting(), { env: { HOOK: SECRET_URL }, fetch, ...quiet, log: (l) => lines.push(l) });
    expect(calls).toEqual([]);
    expect(out).toEqual([{ target: "webhook", ok: false, detail: "HOOK_KEY is not set, and an event is never sent unsigned" }]);
    expect(lines).toEqual(["notify: the waiting event was not delivered to the webhook: HOOK_KEY is not set, and an event is never sent unsigned"]);
  });

  test("retries a 5xx and a network error, not a 4xx, and never prints a URL or a key", async () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    const flaky = recorder(503, 200);
    expect(await sendNotify({ slack: "SLACK" }, waiting(), { env, fetch: flaky.fetch, ...quiet, log })).toEqual([{ target: "slack", ok: true, detail: "delivered" }]);
    expect(flaky.calls).toHaveLength(2);

    const refused = recorder(403);
    expect(await sendNotify({ slack: "SLACK" }, waiting(), { env, fetch: refused.fetch, ...quiet, log })).toEqual([{ target: "slack", ok: false, detail: "HTTP 403" }]);
    expect(refused.calls).toHaveLength(1);

    const down = recorder(new Error(`connect ECONNREFUSED for ${SECRET_URL}`));
    const out = await sendNotify({ webhook: "HOOK", key: "HOOK_KEY" }, waiting(), { env, fetch: down.fetch, attempts: 2, ...quiet, log });
    expect(down.calls).toHaveLength(2);
    expect(out).toEqual([{ target: "webhook", ok: false, detail: "connect ECONNREFUSED for <url>" }]);
    const printed = lines.join("\n");
    for (const secret of [...Object.values(env), "secret-token"]) expect(printed).not.toContain(secret);
  });

  test("a fetch that throws synchronously, or a renderer that throws, is a failed delivery and not a throw", async () => {
    const fetch: NotifyFetch = () => {
      throw new TypeError(`Invalid URL ${SECRET_URL}`);
    };
    const out = await sendNotify({ webhook: "HOOK", key: "HOOK_KEY", teams: "TEAMS" }, waiting(), {
      env,
      fetch,
      attempts: 1,
      ...quiet,
      render: {
        teams: () => {
          throw new Error("no card");
        },
      },
    });
    expect(out).toEqual([
      { target: "webhook", ok: false, detail: "Invalid URL <url>" },
      { target: "teams", ok: false, detail: "no card" },
    ]);
  });

  test("says which variable is unset, sends only the configured events, and does nothing with no config", async () => {
    const { calls, fetch } = recorder(200);
    expect(await sendNotify({ teams: "TEAMS" }, waiting(), { env: {}, fetch, ...quiet })).toEqual([{ target: "teams", ok: false, detail: "TEAMS is not set" }]);
    expect(await sendNotify({ slack: "SLACK", events: ["drift"] }, waiting(), { env, fetch, ...quiet })).toEqual([]);
    expect(await sendNotify(undefined, waiting(), { env, fetch, ...quiet })).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("takes a product's own Slack body and header prefix", async () => {
    const { calls, fetch } = recorder(200);
    await sendNotify({ webhook: "HOOK", key: "HOOK_KEY", slack: "SLACK" }, waiting(), {
      env,
      fetch,
      prefix: "x-yodel",
      userAgent: "sql-yodeler",
      render: { slack: (e) => ({ text: `custom ${e.event}`, blocks: [] }) },
      ...quiet,
    });
    expect(calls[0]!.headers).toHaveProperty("x-yodel-signature");
    expect(calls[0]!.headers["user-agent"]).toBe("sql-yodeler");
    expect(verifyWebhook({ body: calls[0]!.body, headers: calls[0]!.headers, key: "k3y", prefix: "x-yodel" }).ok).toBe(true);
    expect(JSON.parse(calls[1]!.body)).toEqual({ text: "custom waiting", blocks: [] });
  });

  test("webhookRequest signs what it sends", () => {
    const r = webhookRequest(drift(), "k", { now: 100 });
    expect(verifyWebhook({ body: r.body, headers: r.headers, key: "k", now: 100 }).ok).toBe(true);
    expect(r.headers["user-agent"]).toBe("sql-yodeler");
  });
});
