import { describe, test, expect } from "vitest";
import { readGateAuditDecisions, deriveGateAudit, gateLedgerLines, gateLedgerLinesFromLog, readGateAuditLedgers, isOverrideGate } from "./gate-audit";
import { memoryGateLedgerPort } from "../op/gate";

const D1 = "jcs1-sha256:" + "a".repeat(64);
const D2 = "jcs1-sha256:" + "b".repeat(64);

const pending = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: "2026-10-01T10:00:00.000Z", expiresAt: "2026-10-03T10:00:00.000Z", planDigest: D1, runId: "r1", ...o });
const resolution = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, op: "tf-apply", gate: "wave-1", resolvedBy: "alex", timestamp: "2026-10-01T11:00:00.000Z", planDigest: D1, ...o });
const ledger = (op: string, ...texts: string[]) => ({ op, lines: texts.map((text) => ({ text })) });

describe("lifecycle/gate-audit", () => {
  test("a pending fact's wave is surfaced (#3839)", () => {
    const { entries } = deriveGateAudit({ ledgers: [ledger("tf-apply", pending({ wave: { number: 2, name: "prod", op: "tg" } }))] });
    expect(entries[0]).toMatchObject({ wave: { number: 2, name: "prod", op: "tg" } });
    expect(entries[0]!.detail).not.toHaveProperty("wave");
  });

  test("a request, then an approval with its seal and approver", () => {
    const seal = { signer: "alex", key: "SHA256:k", signature: "-----BEGIN" };
    const { entries, gaps } = deriveGateAudit({
      ledgers: [ledger("tf-apply", pending(), resolution({ seal, relayedBy: "slack", note: "ok", approver: { kind: "human", roles: ["ops"] }, via: "relay" }))],
    });
    expect(gaps).toEqual([]);
    expect(entries.map((e) => e.kind)).toEqual(["approval-requested", "approved"]);
    expect(entries[0]).toMatchObject({ gate: "wave-1", digest: D1, runId: "r1", expiresAt: "2026-10-03T10:00:00.000Z" });
    expect(entries[1]).toMatchObject({ by: "alex", seal: "sealed", signer: "alex", relayedBy: "slack", note: "ok", approver: { kind: "human", roles: ["ops"] }, detail: { via: "relay" } });
  });

  test("ids are stable and differ per line", () => {
    const input = { ledgers: [ledger("tf-apply", pending(), resolution())] };
    const a = deriveGateAudit(input).entries;
    const b = deriveGateAudit(input).entries;
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(new Set(a.map((e) => e.id)).size).toBe(2);
  });

  test("a pull request review counts as signed; a bare approval is unsigned", () => {
    const review = { pr: 7, head: "abc", approvers: ["bo"] };
    const { entries } = deriveGateAudit({ ledgers: [ledger("tf-apply", pending(), resolution({ review }), resolution({ timestamp: "2026-10-01T12:00:00.000Z" }))] });
    expect(entries.filter((e) => e.kind === "approved").map((e) => e.seal)).toEqual(["review", "unsigned"]);
    expect(entries.find((e) => e.seal === "review")?.review).toEqual(review);
  });

  test("an approval with no pending fact before it is a gap, also when the digest differs or the fact is later", () => {
    const none = deriveGateAudit({ ledgers: [ledger("tf-apply", resolution())] });
    expect(none.gaps.map((g) => g.kind)).toEqual(["approval-without-request"]);
    const other = deriveGateAudit({ ledgers: [ledger("tf-apply", pending({ planDigest: D2 }), resolution())] });
    expect(other.gaps.map((g) => g.kind)).toEqual(["approval-without-request"]);
    const later = deriveGateAudit({ ledgers: [ledger("tf-apply", resolution({ timestamp: "2026-10-01T09:00:00.000Z" }), pending())] });
    expect(later.gaps.map((g) => g.kind)).toEqual(["approval-without-request"]);
    const old = deriveGateAudit({ ledgers: [ledger("tf-apply", pending({ planDigest: undefined }), resolution())] });
    expect(old.gaps).toEqual([]);
  });

  test("the sealed option flags an unsigned approval and not a sealed or reviewed one", () => {
    const { gaps } = deriveGateAudit({
      ledgers: [ledger("tf-apply", pending(), resolution(), resolution({ review: { pr: 1 } }))],
      sealed: (op) => op === "tf-apply",
    });
    expect(gaps.map((g) => g.kind)).toEqual(["unsealed"]);
  });

  test("overrides: terragucci's denial and SQL Yodeler's override gate", () => {
    const denial = pending({ op: "policy-override", gate: "root/a", planDigest: "sha256:ov", rules: ["r1", "r2"], members: [{ member: "root/a", planDigest: D1 }] });
    const rec = resolution({ op: "policy-override", gate: "root/a", planDigest: "sha256:ov", note: "freeze exception" });
    const yodel = resolution({ op: "migrate", gate: "override-no-drop", note: "legacy table" });
    const { entries, gaps } = deriveGateAudit({ ledgers: [ledger("policy-override", denial, rec), ledger("migrate", yodel)] });
    expect(gaps).toEqual([]);
    expect(entries.map((e) => e.kind)).toEqual(["override-requested", "override-recorded", "override-recorded"]);
    const recorded = entries.filter((e) => e.kind === "override-recorded");
    expect(recorded[0]).toMatchObject({ note: "freeze exception", rules: ["r1", "r2"] });
    expect(recorded[1]).toMatchObject({ note: "legacy table", rules: ["no-drop"] });
    expect(entries.find((e) => e.kind === "override-requested")?.detail).toMatchObject({ members: [{ member: "root/a", planDigest: D1 }] });
  });

  test("a removed line is a revocation by whoever removed it", () => {
    const log = [
      `\x1ec1\x1falex\x1f2026-10-01T11:00:00+00:00\n\ndiff --git a/x b/x\n+${resolution()}\n`,
      `\x1ec2\x1fbo\x1f2026-10-02T08:00:00+00:00\n\ndiff --git a/x b/x\n-${resolution()}\n`,
      `\x1ec3\x1fcy\x1f2026-10-02T09:00:00+00:00\n\ndiff --git a/x b/x\n-${pending({ gate: "gone" })}\n+${pending({ gate: "gone" })}\n`,
    ].join("");
    const lines = gateLedgerLinesFromLog(log);
    expect(lines).toHaveLength(2);
    const { entries } = deriveGateAudit({ ledgers: [{ op: "tf-apply", lines: [{ text: pending() }, ...lines] }] });
    const revoked = entries.find((e) => e.kind === "revoked")!;
    expect(revoked).toMatchObject({ by: "bo", at: "2026-10-02T08:00:00.000Z", subject: "approval", detail: { approvedBy: "alex" } });
    expect(entries.filter((e) => e.kind === "approved")).toHaveLength(1);
  });

  test("each ledger entry names its line: path, number and text as passed in", () => {
    const text = `${pending()}\n\n${resolution()}\n`;
    const { entries } = deriveGateAudit({ ledgers: [{ op: "tf-apply", path: "gates/tf.jsonl", lines: gateLedgerLines(text) }] });
    expect(entries.map((e) => [e.source.path, e.source.line, e.source.text])).toEqual([
      ["gates/tf.jsonl", 1, pending()],
      ["gates/tf.jsonl", 3, resolution()],
    ]);
    const records = deriveGateAudit({ ledgers: [{ op: "tf-apply", lines: [{ record: JSON.parse(pending()) }, { record: JSON.parse(resolution()) }] }] });
    expect(records.entries.map((e) => [e.source.line, e.source.text])).toEqual([[1, undefined], [2, undefined]]);
  });

  test("a caller's id replaces the default, and applies run under it", () => {
    const ledgers = [ledger("tf-apply", pending(), resolution())];
    const id = (e: { source: { path: string; text?: string }; kind: string; id: string }) => (e.source.text ? `mine:${e.source.path}:${e.source.text.length}` : e.id);
    const plain = deriveGateAudit({ ledgers });
    const { entries } = deriveGateAudit({ ledgers, id, applies: [{ ref: "reports/1", at: "2026-10-01T12:00:00.000Z", gate: "wave-1", digest: D1 }] });
    const approved = entries.find((e) => e.kind === "approved")!;
    expect(approved.id).toBe(`mine:_gates/tf-apply.jsonl:${resolution().length}`);
    expect(entries.find((e) => e.kind === "applied")?.under).toBe(approved.id);
    expect(plain.entries.map((e) => e.id)).not.toContain(approved.id);
  });

  test("an approval read from history names who committed it", () => {
    const log = `\x1ec1\x1fmallory\x1f2026-10-01T11:05:00+00:00\x1fm@x.io\n\ndiff --git a/x b/x\n+${pending()}\n+${resolution()}\n`;
    const lines = gateLedgerLinesFromLog(log);
    expect(lines[1]).toEqual({ text: resolution(), commit: "c1", added: { at: "2026-10-01T11:05:00.000Z", by: "mallory", email: "m@x.io" } });
    const { entries } = deriveGateAudit({ ledgers: [{ op: "tf-apply", lines }] });
    const approved = entries.find((e) => e.kind === "approved")!;
    expect(approved).toMatchObject({ by: "alex", committedBy: "mallory", source: { commit: "c1", author: { by: "mallory", email: "m@x.io", at: "2026-10-01T11:05:00.000Z" } } });
    expect(entries.find((e) => e.kind === "approval-requested")?.source.author?.by).toBe("mallory");
    const noEmail = gateLedgerLinesFromLog(`\x1ec2\x1fbo\x1f2026-10-01T11:05:00+00:00\n\n+${resolution()}\n`);
    expect(noEmail[0]?.added).toEqual({ at: "2026-10-01T11:05:00.000Z", by: "bo" });
  });

  test("a sealed pull request approval is a review, with the seal beside it", () => {
    const seal = { signer: "bot", signature: "-----BEGIN" };
    const { entries } = deriveGateAudit({ ledgers: [ledger("tf-apply", pending(), resolution({ seal, via: "pr-review", pr: 4 }), resolution({ seal, timestamp: "2026-10-01T12:00:00.000Z" }))] });
    const approved = entries.filter((e) => e.kind === "approved");
    expect(approved.map((e) => [e.seal, e.sealed, e.signer])).toEqual([["review", true, "bot"], ["sealed", true, "bot"]]);
    expect(approved[0]?.review).toEqual({ pr: 4 });
  });

  test("applies: under an approval, without one, waived, and spending an override", () => {
    const ledgers = [ledger("tf-apply", pending(), resolution()), ledger("policy-override", resolution({ op: "policy-override", gate: "root/a", planDigest: "sha256:ov" }))];
    const ok = { ref: "reports/1", at: "2026-10-01T12:00:00.000Z", gate: "wave-1", digest: D1 };
    const { entries, gaps } = deriveGateAudit({
      ledgers,
      applies: [
        ok,
        { ...ok, ref: "reports/2", digest: D2 },
        { ...ok, ref: "reports/3", digest: D2, approval: "not-required" },
        { ...ok, ref: "reports/4", digest: undefined },
        { ...ok, ref: "reports/5", at: "2026-10-01T10:30:00.000Z" },
        { ...ok, ref: "reports/6", overrides: [{ gate: "root/a", digest: "sha256:ov" }, { gate: "root/b" }] },
      ],
    });
    expect(gaps.map((g) => [g.kind, g.detail.split(" ")[0]])).toEqual([
      ["approval", "reports/2"],
      ["approval", "reports/5"],
      ["override", "reports/6"],
    ]);
    const approved = entries.find((e) => e.kind === "approved")!;
    expect(entries.filter((e) => e.kind === "applied" && e.under === approved.id)).toHaveLength(2);
    const spent = entries.filter((e) => e.kind === "override-spent");
    expect(spent).toHaveLength(1);
    expect(spent[0]).toMatchObject({ gate: "root/a", by: "alex", at: "2026-10-01T12:00:00.000Z" });
  });

  test("malformed lines are gaps and never entries", () => {
    const { entries, gaps } = deriveGateAudit({ ledgers: [ledger("tf-apply", "{nope", JSON.stringify({ version: 2, gate: "g", timestamp: "t" }), pending())] });
    expect(entries).toHaveLength(1);
    expect(gaps.map((g) => g.kind)).toEqual(["malformed-line", "malformed-line"]);
  });

  test("the override rule is replaceable", () => {
    const { entries } = deriveGateAudit({ ledgers: [ledger("x", resolution({ op: "x", gate: "ovr/a" }))], isOverride: (_op, gate) => gate.startsWith("ovr/") });
    expect(entries[0]?.kind).toBe("override-recorded");
    expect(isOverrideGate("policy-override", "r")).toBe(true);
    expect(isOverrideGate("a", "b")).toBe(false);
  });

  test("gateLedgerLines and the port reader feed the same derivation", async () => {
    const text = `${pending()}\n\n${resolution()}\n`;
    const port = memoryGateLedgerPort({ pending: [JSON.parse(pending())], resolutions: [JSON.parse(resolution())] });
    const fromText = deriveGateAudit({ ledgers: [{ op: "tf-apply", lines: gateLedgerLines(text) }] });
    const fromPort = deriveGateAudit({ ledgers: await readGateAuditLedgers(port, ["tf-apply"]) });
    expect(fromPort.entries.map((e) => e.kind)).toEqual(["approval-requested", "approved"]);
    expect(fromPort.entries.map((e) => e.at)).toEqual(fromText.entries.map((e) => e.at));
  });

  describe("op-wave decision records (#3810)", () => {
    const outcomes = [
      { moment: "before-plan", name: "lint", exit: 0, outcome: "passed" },
      { moment: "after-plan", name: "cost", target: "prod", exit: 2, outcome: "held" },
      { moment: "before-apply", name: "backup", exit: 1, outcome: "failed" },
      { moment: "after-apply", name: "skip", exit: 0, outcome: "skipped", reason: "nothing applied" },
    ];
    const record = { wave: 1, name: "prod", op: "tf-apply", gate: "wave-1", digest: D1, heldBy: ["cost"], outcomes };

    test("each outcome becomes a hook entry linked to the approval and the apply", () => {
      const { entries, gaps } = deriveGateAudit({
        ledgers: [ledger("tf-apply", pending(), resolution())],
        applies: [{ ref: "reports/1", at: "2026-10-01T12:00:00.000Z", gate: "wave-1", digest: D1 }],
        decisions: [{ ref: "wave-1.json", at: "2026-10-01T12:05:00.000Z", record }],
      });
      expect(gaps).toEqual([]);
      const hooks = entries.filter((e) => e.kind === "hook");
      expect(hooks.map((h) => h.hook?.outcome)).toEqual(["passed", "held", "failed", "skipped"]);
      expect(hooks[1]!.hook).toMatchObject({ moment: "after-plan", name: "cost", target: "prod", exit: 2 });
      expect(hooks[3]!.hook?.reason).toBe("nothing applied");
      const approved = entries.find((e) => e.kind === "approved")!;
      const applied = entries.find((e) => e.kind === "applied")!;
      for (const h of hooks) expect(h).toMatchObject({ under: approved.id, applied: applied.id, gate: "wave-1", digest: D1, wave: { number: 1, name: "prod" } });
      expect(new Set(hooks.map((h) => h.id)).size).toBe(4);
    });

    test("text input, no approval on file, and a malformed record", () => {
      const { entries, gaps } = deriveGateAudit({
        ledgers: [],
        decisions: [{ ref: "a.json", at: "2026-10-01T12:00:00.000Z", text: JSON.stringify(record) }, { ref: "b.json", at: "2026-10-01T12:00:00.000Z", text: "nope" }],
      });
      expect(entries.filter((e) => e.kind === "hook")).toHaveLength(4);
      expect(entries[0]).not.toHaveProperty("under");
      expect(gaps.map((g) => g.kind)).toEqual(["malformed-line"]);
    });

    test("readGateAuditDecisions reads the json files under a directory", async () => {
      const files: Record<string, string> = { "w1.json": JSON.stringify(record), "notes.txt": "x" };
      const port = { list: async () => Object.keys(files), read: async (_d: string, f: string) => files[f] ?? null };
      const got = await readGateAuditDecisions(port, "_wave-decisions/tf", "2026-10-01T12:00:00.000Z");
      expect(got.map((d) => d.ref)).toEqual(["_wave-decisions/tf/w1.json"]);
      expect(deriveGateAudit({ ledgers: [], decisions: got }).entries).toHaveLength(4);
    });
  });
});
