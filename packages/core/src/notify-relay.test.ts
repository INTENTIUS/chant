/**
 * #4611: `chant notify relay` on loopback. A fake Slack click and a fake
 * Teams reply, signed as the chat platforms sign them, carry a button value
 * signed with the relay key; the ledger is in memory.
 */
import { afterEach, describe, expect, test } from "vitest";
import { assertProductWords, CHANT_WORDS } from "./ci-product-words";
import { makeNotifyEvent, notifyConfigProblem, relayRefOf, relayToken, sendNotify, slackMessage, teamsMessage, RELAY_APPROVE_ACTION, RELAY_DECLINE_ACTION, type NotifyFetch } from "./notify";
import { relayPrincipalFor, slackSignature, startRelayServer, teamsSignature, type RelayDeps, type RelayPending, type RelaySettings } from "./notify-relay";
import { relaySettingsFromEnv } from "./cli/handlers/notify-relay";

const KEY = "relay-key";
const SLACK_SECRET = "slack-secret";
const TEAMS_SECRET = Buffer.from("teams-secret").toString("base64");
const digest = `sha256:${"a".repeat(64)}`;
const moved = `sha256:${"b".repeat(64)}`;
const NOW = new Date("2026-10-27T12:00:00Z");

const settings: RelaySettings = { key: KEY, slackSecret: SLACK_SECRET, teamsSecret: TEAMS_SECRET, maxAgeSeconds: 3600 };

const waitingEvent = (over: { digest?: string; at?: Date; gate?: string } = {}) =>
  makeNotifyEvent(
    { source: "chant", event: "waiting", summary: "wave 2 (prod) of tf-apply waits for an approval", wave: { number: 2, name: "prod", gate: over.gate ?? "tf-apply-wave-2" }, digest: over.digest ?? digest, approve: { command: "chant approve tf-apply tf-apply-wave-2" } },
    { env: {}, now: over.at ?? new Date(NOW.getTime() - 60_000) },
  );
const tokenFor = (event = waitingEvent(), key = KEY) => relayToken(key, relayRefOf(event)!);

/** An in-memory ledger: one standing fact per (op, gate), and the approvals recorded. */
function memoryDeps(over: { pending?: RelayPending[]; refuse?: string } = {}) {
  const approvals: Array<{ op: string; gate: string; planDigest: string; resolvedBy: string; relayedBy: string }> = [];
  let pending: RelayPending[] = over.pending ?? [{ op: "tf-apply", gate: "tf-apply-wave-2", digest }];
  const deps: RelayDeps = {
    principal: "chant-relay",
    words: CHANT_WORDS,
    now: () => NOW,
    signers: async () => ({
      path: ".chant/allowed_signers",
      signers: [
        { principal: "github:ana", line: 1 },
        { principal: "slack:T1/UANA", line: 1 },
        { principal: "teams:aad-ana", line: 1 },
        { principal: "github:bo", line: 2 },
        { principal: "slack:T1/UBO", line: 2 },
        { principal: "chant-relay", line: 3 },
        { principal: "slack:T1/URELAY", line: 3 },
      ],
    }),
    pending: async (d) => pending.filter((p) => p.digest === d),
    approve: async (input) => {
      if (over.refuse) return { ok: false, error: over.refuse };
      approvals.push({ op: input.op, gate: input.gate, planDigest: input.digest, resolvedBy: input.actor, relayedBy: input.relayedBy });
      pending = pending.filter((p) => !(p.op === input.op && p.gate === input.gate));
      return { ok: true };
    },
  };
  return { deps, approvals };
}

function slackBody(user: string, action: string, value: string): string {
  const payload = { type: "block_actions", user: { id: user, team_id: "T1", username: user.toLowerCase() }, actions: [{ action_id: action, value }], container: { message_ts: "1.2" } };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

async function relay(deps: RelayDeps, s: RelaySettings = settings) {
  const posted: Array<{ url: string; body: string }> = [];
  const { url, close } = await startRelayServer(s, deps, { host: "127.0.0.1", port: 0, post: async (u, init) => (posted.push({ url: u, body: init.body }), { ok: true, status: 200 }) });
  servers.push(close);
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const slack = async (body: string, sign: { secret?: string; ts?: number } = {}) => {
    const ts = String(sign.ts ?? Math.floor(Date.now() / 1000));
    const res = await fetch(`${url}/slack`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": slackSignature(sign.secret ?? SLACK_SECRET, ts, body) }, body });
    return { status: res.status, text: await res.text() };
  };
  const teams = async (text: string, user = "aad-ana", secret = TEAMS_SECRET) => {
    const body = JSON.stringify({ type: "message", text, from: { aadObjectId: user, name: "Ana" } });
    const res = await fetch(`${url}/teams`, { method: "POST", headers: { "content-type": "application/json", authorization: teamsSignature(secret, body) }, body });
    // A refused signature answers 401 in plain text; a reply the relay makes is Teams' JSON.
    const raw = await res.text();
    return { status: res.status, json: (res.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : { text: raw }) as { text: string } };
  };
  return { url, posted, slack, teams };
}

describe("chant notify relay (#4611)", () => {
  test("a signed Slack click records the approval with relayedBy, and replies in the thread", async () => {
    const { deps, approvals } = memoryDeps();
    const r = await relay(deps);
    const out = await r.slack(slackBody("UANA", RELAY_APPROVE_ACTION, tokenFor()));
    expect(out.status).toBe(200);
    expect(approvals).toEqual([{ op: "tf-apply", gate: "tf-apply-wave-2", planDigest: digest, resolvedBy: "github:ana", relayedBy: "chant-relay" }]);
    // No response_url in the fake payload, so no reply is posted.
    expect(r.posted).toEqual([]);
  });

  test("a signed Teams reply approves the same way", async () => {
    const { deps, approvals } = memoryDeps();
    const r = await relay(deps);
    const out = await r.teams(`<at>chant</at> approve ${tokenFor()}`);
    expect(out.json.text).toMatch(/^tf-apply-wave-2 on tf-apply approved by github:ana, relayed by chant-relay, for sha256:a{64}/);
    expect(approvals).toHaveLength(1);
  });

  test("a bad chat signature is refused with 401 and records nothing", async () => {
    const { deps, approvals } = memoryDeps();
    const r = await relay(deps);
    expect((await r.slack(slackBody("UANA", RELAY_APPROVE_ACTION, tokenFor()), { secret: "wrong" })).status).toBe(401);
    expect((await r.slack(slackBody("UANA", RELAY_APPROVE_ACTION, tokenFor()), { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await r.teams(`approve ${tokenFor()}`, "aad-ana", Buffer.from("other").toString("base64"))).status).toBe(401);
    expect(approvals).toEqual([]);
  });

  test("a button the relay key did not sign is refused", async () => {
    const { deps, approvals } = memoryDeps();
    const r = await relay(deps);
    const out = await r.teams(`approve ${tokenFor(waitingEvent(), "another-key")}`);
    expect(out.json.text).toMatch(/not signed with this relay's key/);
    const forged = tokenFor().replace(/\.[0-9a-f]+$/, ".00");
    expect((await r.teams(`approve ${forged}`)).json.text).toMatch(/not signed with this relay's key/);
    expect(approvals).toEqual([]);
  });

  test("a stale event is refused", async () => {
    const { deps, approvals } = memoryDeps();
    const r = await relay(deps);
    const old = waitingEvent({ at: new Date(NOW.getTime() - 2 * 3600_000) });
    expect((await r.teams(`approve ${tokenFor(old)}`)).json.text).toMatch(/more than 3600s old/);
    expect(approvals).toEqual([]);
  });

  test("an ineligible clicker is refused: unmapped, the relay itself, or the requester of a gated request", async () => {
    const request = { kind: "state-export", subject: "net", by: "github:bo", at: NOW.toISOString(), fields: {} };
    const { deps, approvals } = memoryDeps({ pending: [{ op: "state-export", gate: "net", digest, request }] });
    const r = await relay(deps);
    const token = tokenFor(waitingEvent({ gate: "net" }));
    expect((await r.teams(`approve ${token}`, "aad-stranger")).json.text).toMatch(/is not mapped to a principal in \.chant\/allowed_signers/);
    await r.slack(slackBody("URELAY", RELAY_APPROVE_ACTION, token));
    await r.slack(slackBody("UBO", RELAY_APPROVE_ACTION, token));
    expect(approvals).toEqual([]);
    // Someone other than the requester approves it.
    await r.slack(slackBody("UANA", RELAY_APPROVE_ACTION, token));
    expect(approvals).toEqual([{ op: "state-export", gate: "net", planDigest: digest, resolvedBy: "github:ana", relayedBy: "chant-relay" }]);
  });

  test("a digest that moved approves nothing, and neither does a second click", async () => {
    const { deps, approvals } = memoryDeps({ pending: [{ op: "tf-apply", gate: "tf-apply-wave-2", digest: moved }] });
    const r = await relay(deps);
    expect((await r.teams(`approve ${tokenFor()}`)).json.text).toMatch(/does not wait for sha256:a{64}\. The plan moved since this message/);
    expect(approvals).toEqual([]);
    const fresh = tokenFor(waitingEvent({ digest: moved }));
    await r.teams(`approve ${fresh}`);
    expect((await r.teams(`approve ${fresh}`)).json.text).toMatch(/does not wait for/);
    expect(approvals).toHaveLength(1);
  });

  test("chant approve's refusal reaches the thread, and decline records nothing", async () => {
    const { deps, approvals } = memoryDeps({ refuse: 'Gate "tf-apply-wave-2" needs a signed approval' });
    const r = await relay(deps);
    expect((await r.teams(`approve ${tokenFor()}`)).json.text).toBe('Not approved: Gate "tf-apply-wave-2" needs a signed approval');
    expect((await r.teams(`decline ${tokenFor()}`)).json.text).toMatch(/declined by github:ana .* Nothing was recorded/);
    expect(approvals).toEqual([]);
  });

  test("only the three paths answer", async () => {
    const r = await relay(memoryDeps().deps);
    expect((await fetch(`${r.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${r.url}/approve`, { method: "POST", body: "x" })).status).toBe(404);
  });
});

describe("the buttons notify posts (#4611)", () => {
  test("a waiting event's Slack message carries Approve and Decline with the signed reference, and Teams the reply", async () => {
    const event = waitingEvent();
    const token = tokenFor(event);
    const slack = slackMessage(event, { token });
    expect(slack.text).toBe(slackMessage(event).text);
    expect(JSON.stringify(slack.blocks)).toContain(RELAY_APPROVE_ACTION);
    expect(JSON.stringify(slack.blocks)).toContain(RELAY_DECLINE_ACTION);
    expect(JSON.stringify(teamsMessage(event, { token }))).toContain(`approve ${token}`);
    expect(slackMessage(event)).toEqual({ text: slackMessage(event).text });
  });

  test("sendNotify adds buttons only for a waiting event and only with the relay key set", async () => {
    const bodies: string[] = [];
    const fetch: NotifyFetch = async (_u, init) => (bodies.push(init.body), { ok: true, status: 200 });
    const config = { slack: "SLACK", relay: "CHANT_RELAY_KEY" };
    expect(notifyConfigProblem(config)).toBeUndefined();
    expect(notifyConfigProblem({ slack: "SLACK", relay: "abc def" })).toMatch(/notify\.relay: the name of the environment variable that holds the relay key/);
    await sendNotify(config, waitingEvent(), { env: { SLACK: "http://127.0.0.1:9/s", CHANT_RELAY_KEY: KEY }, fetch, log: () => {} });
    await sendNotify(config, waitingEvent(), { env: { SLACK: "http://127.0.0.1:9/s" }, fetch, log: () => {} });
    const failed = makeNotifyEvent({ source: "chant", event: "failed", summary: "x" }, { env: {} });
    await sendNotify(config, failed, { env: { SLACK: "http://127.0.0.1:9/s", CHANT_RELAY_KEY: KEY }, fetch, log: () => {} });
    expect(bodies.map((b) => "blocks" in JSON.parse(b))).toEqual([true, false, false]);
  });

  test("a product's relay replies in its words, and a chat user on two lines maps to nobody", async () => {
    const { deps } = memoryDeps();
    const plywood = { ...deps, principal: "plywood-relay", words: assertProductWords({ product: "plywood", stages: { plan: "preview", apply: "up" } }) };
    const r = await relay(plywood);
    expect((await r.teams(`approve ${tokenFor()}`)).json.text).toMatch(/relayed by plywood-relay, .* The resume job starts the up once the gate passes\./);
    expect(relayPrincipalFor([{ principal: "a", line: 1 }, { principal: "slack:T/U", line: 1 }, { principal: "b", line: 2 }, { principal: "slack:T/U", line: 2 }], "slack:T/U")).toBeUndefined();
  });

  test("the relay will not start without a key or a chat secret", () => {
    expect(relaySettingsFromEnv({})).toMatchObject({ error: expect.stringMatching(/CHANT_RELAY_KEY is not set/) });
    expect(relaySettingsFromEnv({ CHANT_RELAY_KEY: "k" })).toMatchObject({ error: expect.stringMatching(/SLACK_SIGNING_SECRET, TEAMS_WEBHOOK_SECRET or both/) });
    expect(relaySettingsFromEnv({ CHANT_RELAY_KEY: "k", SLACK_SIGNING_SECRET: "s" })).toMatchObject({ host: "127.0.0.1", port: 8787, settings: { key: "k", slackSecret: "s", maxAgeSeconds: 86400 } });
  });
});
