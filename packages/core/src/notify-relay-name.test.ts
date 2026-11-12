/**
 * #5033: a notify config's `relayName`, the relay's name as people mention
 * it in Teams, so a waiting event's card says the whole reply. The
 * `notify-defaults` golden was written from main before the change: a
 * config without it sends what it sent.
 */
import { describe, expect, test } from "vitest";
import { makeNotifyEvent, notifyConfigProblem, notifyVariables, sendNotify, type NotifyFetch } from "./notify";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const GITHUB = { GITHUB_ACTIONS: "true", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/db", GITHUB_RUN_ID: "42", GITHUB_SHA: "abc123" };
const DIGEST = "jcs1-sha256:" + "a".repeat(64);
const env = { ...GITHUB, SLACK: "https://hooks.slack.com/services/T/B/x", TEAMS: "https://teams.example/workflows/x", RELAY_KEY: "relay-secret" };

const waiting = makeNotifyEvent(
  {
    source: "terragucci",
    event: "waiting",
    summary: "wave 1 (wave-1) of tf-apply waits for an approval",
    wave: { number: 1, name: "wave-1", gate: "wave-1" },
    targets: ["network"],
    digest: DIGEST,
    approve: { command: `terragucci approve tf-apply wave-1 --plan ${DIGEST}` },
  },
  { env: GITHUB, now: NOW },
);

/** What each target was sent, by its URL's order. */
async function sent(config: Parameters<typeof sendNotify>[0]): Promise<unknown[]> {
  const bodies: unknown[] = [];
  const fetch: NotifyFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };
  await sendNotify(config, waiting, { env, fetch, now: 1_760_184_000, sleep: async () => {}, log: () => {} });
  return bodies;
}

type Card = { attachments: Array<{ content: { body: Array<{ type: string; text?: string; facts?: Array<{ title: string; value: string }> }> } }> };
const texts = (card: unknown): string => JSON.stringify((card as Card).attachments[0]!.content.body);

describe("notify with relayName (#5033)", () => {
  test("the Teams card says the whole reply, mentioning the relay by name", async () => {
    const [, teams] = await sent({ slack: "SLACK", teams: "TEAMS", relay: "RELAY_KEY", relayName: "Terragucci Relay" });
    expect(texts(teams)).toContain("reply @Terragucci Relay approve ");
    expect(texts(teams)).not.toContain("mention the relay and reply");
  });

  test("it is over the product's words' own name", async () => {
    const bodies: unknown[] = [];
    const fetch: NotifyFetch = async (_url, init) => (bodies.push(JSON.parse(init.body)), { ok: true, status: 200 });
    await sendNotify({ teams: "TEAMS", relay: "RELAY_KEY", relayName: "acme-relay" }, waiting, { env, fetch, message: { relayName: "words-relay" }, sleep: async () => {}, log: () => {} });
    expect(texts(bodies[0])).toContain("reply @acme-relay approve ");
  });

  test("without the relay's key there are no buttons, so the name changes nothing", async () => {
    expect(await sent({ teams: "TEAMS", relayName: "acme-relay" })).toEqual(await sent({ teams: "TEAMS" }));
  });

  test("it is checked, and named by no variable", () => {
    expect(notifyConfigProblem({ teams: "TEAMS", relayName: "acme-relay" })).toBeUndefined();
    for (const bad of ["", " lead", "@acme", "a<b>", "two\nlines", "x".repeat(81), 7]) expect(notifyConfigProblem({ teams: "TEAMS", relayName: bad }), String(bad)).toMatch(/relayName/);
    expect(notifyVariables({ teams: "TEAMS", relay: "RELAY_KEY", relayName: "acme-relay" })).toEqual(["TEAMS", "RELAY_KEY"]);
  });
});

describe("notify without relayName (#5033)", () => {
  test("Slack and Teams get what they got before", async () => {
    await expect(JSON.stringify(await sent({ slack: "SLACK", teams: "TEAMS", relay: "RELAY_KEY" }), null, 2) + "\n").toMatchFileSnapshot("./__golden__/notify-defaults-relay.json");
    await expect(JSON.stringify(await sent({ teams: "TEAMS" }), null, 2) + "\n").toMatchFileSnapshot("./__golden__/notify-defaults-plain.json");
  });
});
