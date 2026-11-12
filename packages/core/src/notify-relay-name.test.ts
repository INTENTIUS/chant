/**
 * #5033: a notify config's `relayName`, the relay's name as people mention
 * it in Teams, so a waiting event's card says the whole reply. The
 * `notify-defaults` golden was written from main before the change: a
 * config without it sends what it sent.
 */
import { describe, expect, test } from "vitest";
import { makeNotifyEvent, sendNotify, type NotifyFetch } from "./notify";

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

describe("notify without relayName (#5033)", () => {
  test("Slack and Teams get what they got before", async () => {
    await expect(JSON.stringify(await sent({ slack: "SLACK", teams: "TEAMS", relay: "RELAY_KEY" }), null, 2) + "\n").toMatchFileSnapshot("./__golden__/notify-defaults-relay.json");
    await expect(JSON.stringify(await sent({ teams: "TEAMS" }), null, 2) + "\n").toMatchFileSnapshot("./__golden__/notify-defaults-plain.json");
  });
});
