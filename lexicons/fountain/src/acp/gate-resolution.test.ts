import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * chant#2400 — an ACP session cannot clear a gate it produced.
 *
 * The `Steward` composite ships `permission_policy: { default: "auto_allow" }`,
 * with a comment explaining that chant's own gates are where a human belongs.
 * On the `--durable-requests` path that was not true. A gate became a
 * `session/request_permission` (`./turn.ts`'s `gatedReply`), `auto_allow`
 * answered it without anyone, and `AcpServer.resume` then wrote a real gate
 * resolution and re-ran the command, which walked through the gate. The
 * composite's doc described a separation its configuration removed, which is
 * how it survived review: a reader finds an argument rather than a smell.
 *
 * chant#2384 did not close it, and the reason is the interesting part.
 * `createChantHost`'s `resolveGate` called `appendGateResolution` DIRECTLY,
 * writing a line that looked like an approval while skipping every check one
 * carries: #2300's plan binding, so the resolution named no plan and
 * authorised whatever the next run produced rather than what anyone read; the
 * standing-pending-fact requirement, so it could answer a gate nothing had
 * reached; and #2384's origin rule, which is the one that bites here.
 *
 * Routed through `recordGateApproval`, the same function `chant approve`
 * calls, the rule applies: the pending fact and the resolution are both
 * authored by the same ACP session, so it refuses. The property is now a
 * consequence of the mechanism rather than of how a composite is configured.
 */
const HOST = fileURLToPath(new URL("./host.ts", import.meta.url));
const STEWARD = fileURLToPath(new URL("../composites/steward.ts", import.meta.url));

describe("an ACP gate resolution goes through the same door as chant approve (chant#2400)", () => {
  const host = readFileSync(HOST, "utf8");

  test("resolveGate calls recordGateApproval, not appendGateResolution", () => {
    expect(host).toContain("recordGateApproval");

    // The direct call is the defect. Writing the ledger line without the
    // checks around it produces a record indistinguishable from an approval,
    // which is worse than failing to write one.
    //
    // Matched on the import rather than the bare name, so the comment above
    // `resolveGate` can go on explaining what it no longer does. A test that
    // fails on its own subject being mentioned teaches people to stop
    // mentioning it.
    const importsLedgerWriter = /import\("@intentius\/chant\/lifecycle\/gate-ledger"\)/.test(host)
      && /\bappendGateResolution\s*[,}]/.test(host);
    expect(
      importsLedgerWriter,
      "resolveGate must not append a resolution directly — that skips the plan binding, the " +
        "standing-pending-fact requirement and the origin rule",
    ).toBe(false);
  });

  test("it names the ACP channel, so the origin rule has something to compare", () => {
    // Without an origin the rule cannot fire: `sameOriginRefusal` matches
    // positively, so an unlabelled resolution is never refused.
    expect(host).toMatch(/origin:\s*"acp"/);
  });

  test("a refusal is surfaced rather than swallowed", () => {
    // `recordGateApproval` reports failure by returning `{ ok: false }` and
    // printing. A caller that ignored that would carry on and re-run the
    // command, which is exactly the bypass this closes.
    expect(host).toMatch(/outcome\.ok/);
    expect(host).toContain("chant approve");
  });

  test("the Steward's doc no longer claims a separation its configuration removes", () => {
    const steward = readFileSync(STEWARD, "utf8");

    // The configuration is unchanged and deliberately so: `auto_allow` is right
    // for ordinary tool calls on a machine with nobody at the keyboard. What
    // changed is that it can no longer clear a gate, and the doc has to say
    // which of those it means.
    expect(steward).toContain('permission_policy: { default: "auto_allow" }');
    expect(steward).toMatch(/cannot clear a gate/);
    expect(steward).toMatch(/chant#2384|origin rule/);
  });
});
