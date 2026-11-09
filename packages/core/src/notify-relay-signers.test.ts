/**
 * #4803: the relay maps a chat user to a principal from the signers file at
 * the default branch's tip. When that file's signer history doesn't verify,
 * the rest of chant trusts no key in it (`trust-policy-unreadable`), so the
 * relay maps no clicker from it either.
 */
import { afterEach, describe, expect, test } from "vitest";
import { CHANT_WORDS } from "./ci-product-words";
import { makeNotifyEvent, relayRefOf, relayToken } from "./notify";
import { decideRelayClick, type RelayDeps } from "./notify-relay";
import { checkoutRelayDeps } from "./cli/handlers/notify-relay";
import { hasSshKeygen, TestRepo, writeRecordKind, type Key } from "./workspace/trust/test-repo";

const KEY = "relay-key";
const digest = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-10-27T12:00:00Z");

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const line = (principals: string[], k: Key) => `${principals.join(",")} ${k.pub}`;

function token(): string {
  const event = makeNotifyEvent(
    { source: "chant", event: "waiting", summary: "wave 2 (prod) of tf-apply waits for an approval", wave: { number: 2, name: "prod", gate: "tf-apply-wave-2" }, digest, approve: { command: "chant approve tf-apply tf-apply-wave-2" } },
    { env: {}, now: new Date(NOW.getTime() - 60_000) },
  );
  return relayToken(KEY, relayRefOf(event)!);
}

/** The checkout's signers, and an in-memory gate that records what is approved. */
function depsFor(dir: string) {
  const approvals: string[] = [];
  const real = checkoutRelayDeps(dir, "chant-relay");
  const deps: RelayDeps = {
    principal: "chant-relay",
    words: CHANT_WORDS,
    now: () => NOW,
    signers: real.signers,
    pending: async (d) => (d === digest ? [{ op: "tf-apply", gate: "tf-apply-wave-2", digest }] : []),
    approve: async (input) => (approvals.push(input.actor), { ok: true }),
  };
  return { deps, approvals };
}

const click = (chatUser: string) => ({ app: "slack" as const, action: "approve" as const, token: token(), chatUser, display: chatUser });

describe.skipIf(!hasSshKeygen)("the relay and the signer history (#4803)", () => {
  function setup(label: string) {
    const r = new TestRepo(label);
    repos.push(r);
    const ana = r.key("ana");
    const mallory = r.key("mallory");
    writeRecordKind(r);
    r.write(".chant/allowed_signers", line(["github:ana", "slack:T1/UANA"], ana) + "\n");
    r.commit("signers v1", ana);
    return { r, ana, mallory };
  }

  test("a signers file whose history verifies maps the clicker", async () => {
    const { r } = setup("relay-ok");
    const { deps, approvals } = depsFor(r.dir);
    const out = await decideRelayClick(click("slack:T1/UANA"), { key: KEY, maxAgeSeconds: 3600 }, deps);
    expect(out.outcome).toBe("approved");
    expect(approvals).toEqual(["github:ana"]);
  });

  test("a signer added on main without a rotation breaks the history, and the relay maps no one", async () => {
    const { r, ana, mallory } = setup("relay-broken");
    r.write(".chant/allowed_signers", [line(["github:ana", "slack:T1/UANA"], ana), line(["github:mallory", "slack:T1/UMAL"], mallory)].join("\n") + "\n");
    r.commit("pushed straight to main", mallory);
    const { deps, approvals } = depsFor(r.dir);
    for (const user of ["slack:T1/UMAL", "slack:T1/UANA"]) {
      const out = await decideRelayClick(click(user), { key: KEY, maxAgeSeconds: 3600 }, deps);
      expect(out.ok).toBe(false);
      expect(out.outcome).toBe("refused");
      expect(out.text).toMatch(/\[trust-policy-unreadable\]/);
      expect(out.text).toMatch(/signer history .* is broken/);
    }
    expect(approvals).toEqual([]);
  });
});
