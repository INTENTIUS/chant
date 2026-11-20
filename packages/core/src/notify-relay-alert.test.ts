/**
 * #5329: the relay's `POST /alert/<source>`. A delivery is checked, its
 * firing alerts recorded once as facts signed with the relay key, and the
 * alert agent's workflow started with a token that can do nothing else.
 * The ledger and the forge are in memory.
 */
import { describe, expect, test } from "vitest";
import { duplicateOf, verifyAgentFact, type AgentFact } from "./agent-facts";
import { genericAlertSignature, pagerdutySignature } from "./ci-agent-alert";
import { CHANT_WORDS } from "./ci-product-words";
import { relaySettingsFromEnv } from "./cli/handlers/notify-relay";
import { handleRelayRequest, type RelayDeps, type RelaySettings } from "./notify-relay";
import { checkDispatchToken, dispatchAgentWorkflow, dispatchTokenVerdict, relayRepo, type RelayRepo } from "./notify-relay-repo";
import type { ForgeFetch } from "./pr-forge";

const KEY = "relay-key";
const SECRET = "alert-secret";
const NOW = new Date("2026-11-19T12:00:00Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

function memory(o: { failRecord?: boolean; failDispatch?: boolean } = {}) {
  const ledger: AgentFact[] = [];
  const log: string[] = [];
  let starts = 0;
  const deps: RelayDeps = {
    principal: "chant-relay",
    words: CHANT_WORDS,
    now: () => NOW,
    signers: async () => ({ path: ".chant/allowed_signers", signers: [] }),
    pending: async () => [],
    approve: async () => {
      throw new Error("an alert approves nothing");
    },
    recordAlerts: async (facts) => {
      if (o.failRecord) throw new Error("the ledger push was refused");
      const recorded: AgentFact[] = [];
      const duplicates: AgentFact[] = [];
      for (const f of facts) (duplicateOf(f, ledger) ? duplicates : (ledger.push(f), recorded)).push(f);
      return { recorded, duplicates };
    },
    dispatch: async () => {
      starts++;
      return o.failDispatch ? { ok: false, error: "workflow_dispatch answered 403" } : { ok: true };
    },
  };
  return { deps, ledger, log, starts: () => starts };
}

const settings: RelaySettings = { key: KEY, alertSecrets: { generic: SECRET, pagerduty: SECRET } };

function genericRequest(body: unknown, o: { path?: string; secret?: string; headers?: Record<string, string> } = {}) {
  const raw = JSON.stringify(body);
  return {
    method: "POST",
    path: o.path ?? "/alert/generic",
    headers: { "x-chant-timestamp": TS, "x-chant-signature": genericAlertSignature(o.secret ?? SECRET, TS, raw), ...(o.headers ?? {}) },
    body: raw,
  };
}

describe("POST /alert/<source> (#5329)", () => {
  test("records each firing alert as a fact signed with the relay key, and starts the agent's workflow", async () => {
    const m = memory();
    const res = await handleRelayRequest(genericRequest({ id: "g1", title: "queue backed up" }, { path: "/alert/generic?member=worker" }), settings, m.deps, { log: (l) => m.log.push(l) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ recorded: 1, duplicates: 0, started: true });
    expect(m.ledger).toHaveLength(1);
    expect(m.ledger[0]).toMatchObject({ trigger: "alert", member: "worker", key: "generic:g1", by: "chant-relay", received: NOW.toISOString(), data: { title: "queue backed up" } });
    expect(verifyAgentFact(KEY, m.ledger[0]!)).toBe(true);
    expect(m.starts()).toBe(1);
  });

  test("a retried delivery is recorded once and starts nothing more, by the source's id or by its Idempotency-Key", async () => {
    const m = memory();
    await handleRelayRequest(genericRequest({ id: "g1", title: "t" }, { headers: { "idempotency-key": "k1" } }), settings, m.deps);
    const again = await handleRelayRequest(genericRequest({ id: "g1", title: "t" }), settings, m.deps);
    expect(JSON.parse(again.body)).toMatchObject({ recorded: 0, duplicates: 1, started: false });
    const sameDelivery = await handleRelayRequest(genericRequest({ id: "g9", title: "t" }, { headers: { "idempotency-key": "k1" } }), settings, m.deps);
    expect(JSON.parse(sameDelivery.body)).toMatchObject({ recorded: 0, duplicates: 1 });
    expect(m.ledger).toHaveLength(1);
    expect(m.starts()).toBe(1);
  });

  test("an unsigned or stale delivery is refused with 401 and logged, and nothing is recorded", async () => {
    const m = memory();
    const unsigned = await handleRelayRequest({ method: "POST", path: "/alert/generic", headers: {}, body: '{"id":"g1","title":"t"}' }, settings, m.deps, { log: (l) => m.log.push(l) });
    expect(unsigned.status).toBe(401);
    const wrong = await handleRelayRequest(genericRequest({ id: "g1", title: "t" }, { secret: "not-it" }), settings, m.deps, { log: (l) => m.log.push(l) });
    expect(wrong.status).toBe(401);
    const oldTs = String(Number(TS) - 3600);
    const raw = '{"id":"g1","title":"t"}';
    const stale = await handleRelayRequest({ method: "POST", path: "/alert/generic", headers: { "x-chant-timestamp": oldTs, "x-chant-signature": genericAlertSignature(SECRET, oldTs, raw) }, body: raw }, settings, m.deps, { log: (l) => m.log.push(l) });
    expect(stale.status).toBe(401);
    expect(m.log).toEqual([
      "alert generic: refused a delivery: the delivery is not signed",
      "alert generic: refused a delivery: the signature does not verify",
      expect.stringMatching(/^alert generic: refused a delivery: the delivery is more than 900s old/),
    ]);
    expect(m.ledger).toEqual([]);
    expect(m.starts()).toBe(0);
  });

  test("alerts are off until a source has a secret: the route answers 404", async () => {
    const m = memory();
    const off = await handleRelayRequest(genericRequest({ id: "g1", title: "t" }), { key: KEY }, m.deps);
    expect(off.status).toBe(404);
    const otherSource = await handleRelayRequest({ ...genericRequest({}), path: "/alert/sentry" }, settings, m.deps);
    expect(otherSource.status).toBe(404);
    expect(m.ledger).toEqual([]);
  });

  test("a fact that could not be written answers 500 so the source sends again; a start that failed is logged and the fact stays", async () => {
    const failed = memory({ failRecord: true });
    expect((await handleRelayRequest(genericRequest({ id: "g1", title: "t" }), settings, failed.deps)).status).toBe(500);
    expect(failed.starts()).toBe(0);
    const noStart = memory({ failDispatch: true });
    const res = await handleRelayRequest(genericRequest({ id: "g1", title: "t" }), settings, noStart.deps, { log: (l) => noStart.log.push(l) });
    expect(res.status).toBe(200);
    expect(noStart.ledger).toHaveLength(1);
    expect(noStart.log.at(-1)).toContain("its schedule picks the alert up");
  });

  test("a PagerDuty delivery with the source's own signature", async () => {
    const m = memory();
    const raw = JSON.stringify({ event: { event_type: "incident.triggered", occurred_at: NOW.toISOString(), data: { id: "Q1", title: "db down" } } });
    const res = await handleRelayRequest({ method: "POST", path: "/alert/pagerduty?member=db", headers: { "x-pagerduty-signature": pagerdutySignature(SECRET, raw) }, body: raw }, settings, m.deps);
    expect(res.status).toBe(200);
    expect(m.ledger[0]).toMatchObject({ key: "pagerduty:Q1", member: "db" });
  });
});

describe("the relay's alert settings", () => {
  test("a shared secret turns every source on, a source's own secret wins, and alerts alone start the relay", () => {
    const out = relaySettingsFromEnv({ CHANT_RELAY_KEY: KEY, CHANT_ALERT_SECRET: "shared", CHANT_ALERT_SECRET_PAGERDUTY: "pd", CHANT_ALERT_MAX_AGE: "300" });
    expect(out).toMatchObject({ settings: { alertSecrets: { generic: "shared", pagerduty: "pd", alertmanager: "shared" }, alertMaxAgeSeconds: 300 } });
    expect(relaySettingsFromEnv({ CHANT_RELAY_KEY: KEY })).toMatchObject({ error: expect.stringContaining("CHANT_ALERT_SECRET") });
    expect(relaySettingsFromEnv({ CHANT_RELAY_KEY: KEY, SLACK_SIGNING_SECRET: "s" })).not.toHaveProperty("settings.alertSecrets");
  });
});

// ── the dispatch token ─────────────────────────────────────────────────────

/** A fake forge: answers by method and path, and keeps what it was asked. */
function forge(answers: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>) {
  const seen: Array<{ method: string; url: string; body?: string; headers: Record<string, string> }> = [];
  const fetchImpl: ForgeFetch = async (url, init) => {
    seen.push({ method: init.method, url, ...(init.body !== undefined ? { body: init.body } : {}), headers: init.headers });
    const a = answers[`${init.method} ${new URL(url).pathname}`] ?? { status: 404 };
    const h = a.headers ?? {};
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => (a.body === undefined ? "" : JSON.stringify(a.body)), headers: { get: (n: string) => h[n.toLowerCase()] ?? null } } as unknown as Awaited<ReturnType<ForgeFetch>>;
  };
  return { fetchImpl, seen };
}

const github = relayRepo("https://github.com/acme/infra.git") as RelayRepo;
const gitlab = relayRepo("https://gitlab.com/acme/infra.git") as RelayRepo;
const forgejo = relayRepo("https://code.acme.dev/acme/infra.git", "forgejo") as RelayRepo;

describe("the dispatch token may only start a workflow", () => {
  test("GitHub: a token that cannot create a ref passes; one that can, a classic token or an admin's is refused", async () => {
    const ok = forge({ "GET /repos/acme/infra": { status: 200, body: { permissions: { admin: false, push: true } } }, "POST /repos/acme/infra/git/refs": { status: 403 } });
    expect(await checkDispatchToken(github, "t", ok.fetchImpl)).toEqual({ ok: true });
    expect(ok.seen[1]!.body).toContain('"sha":"0000000000000000000000000000000000000000"');
    const writes = forge({ "GET /repos/acme/infra": { status: 200, body: { permissions: {} } }, "POST /repos/acme/infra/git/refs": { status: 422 } });
    expect(await checkDispatchToken(github, "t", writes.fetchImpl)).toMatchObject({ error: expect.stringContaining("can write acme/infra's contents") });
    const classic = forge({ "GET /repos/acme/infra": { status: 200, body: {}, headers: { "x-oauth-scopes": "repo" } }, "POST /repos/acme/infra/git/refs": { status: 403 } });
    expect(await checkDispatchToken(github, "t", classic.fetchImpl)).toMatchObject({ error: expect.stringContaining("classic") });
    expect(dispatchTokenVerdict({ kind: "github", classic: false, admin: true, refWrite: 403 }, "acme/infra")).toContain("administers");
  });

  test("GitLab: a pipeline trigger token passes; an access token is refused", async () => {
    const trigger = forge({ "GET /api/v4/personal_access_tokens/self": { status: 401 } });
    expect(await checkDispatchToken(gitlab, "glptt-abc", trigger.fetchImpl)).toEqual({ ok: true });
    const pat = forge({ "GET /api/v4/personal_access_tokens/self": { status: 200, body: { scopes: ["api"] } } });
    expect(await checkDispatchToken(gitlab, "glpat-abc", pat.fetchImpl)).toMatchObject({ error: expect.stringContaining("access token") });
    expect(await checkDispatchToken(gitlab, "something-else", trigger.fetchImpl)).toMatchObject({ error: expect.stringContaining("glptt-") });
  });

  test("Forgejo: a user who may push or administers the repository is refused", async () => {
    const push = forge({ "GET /api/v1/repos/acme/infra": { status: 200, body: { permissions: { admin: false, push: true } } } });
    expect(await checkDispatchToken(forgejo, "t", push.fetchImpl)).toMatchObject({ error: expect.stringContaining("may push") });
    const actionsOnly = forge({ "GET /api/v1/repos/acme/infra": { status: 200, body: { permissions: { admin: false, push: false, pull: true } } } });
    expect(await checkDispatchToken(forgejo, "t", actionsOnly.fetchImpl)).toEqual({ ok: true });
  });
});

describe("starting the workflow", () => {
  test("GitHub and Forgejo: a workflow_dispatch of the named file on the default branch, with no inputs", async () => {
    const f = forge({ "POST /repos/acme/infra/actions/workflows/chant-alert-agent.yml/dispatches": { status: 204 } });
    expect(await dispatchAgentWorkflow({ repo: github, token: "t", branch: "main", workflow: "chant-alert-agent.yml", fetch: f.fetchImpl })).toEqual({ ok: true });
    expect(JSON.parse(f.seen[0]!.body!)).toEqual({ ref: "main" });
    const fj = forge({ "POST /api/v1/repos/acme/infra/actions/workflows/chant-alert-agent.yml/dispatches": { status: 204 } });
    expect(await dispatchAgentWorkflow({ repo: forgejo, token: "t", branch: "main", workflow: "chant-alert-agent.yml", fetch: fj.fetchImpl })).toEqual({ ok: true });
    expect(await dispatchAgentWorkflow({ repo: github, token: "t", branch: "main", workflow: "../x", fetch: f.fetchImpl })).toMatchObject({ ok: false });
  });

  test("GitLab: a pipeline of the default branch from the trigger token, with no variables", async () => {
    const f = forge({ "POST /api/v4/projects/acme%2Finfra/trigger/pipeline": { status: 201 } });
    expect(await dispatchAgentWorkflow({ repo: gitlab, token: "glptt-abc", branch: "main", fetch: f.fetchImpl })).toEqual({ ok: true });
    expect(f.seen[0]!.body).toBe("token=glptt-abc&ref=main");
  });
});
