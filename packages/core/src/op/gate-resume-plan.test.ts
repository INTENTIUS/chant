import { describe, expect, test } from "vitest";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { parseAppliedGateFile } from "../lifecycle/gate-applied";
import { planGateResumes } from "./gate-resume-plan";
import type { GateRunLocator } from "./gate-run-locator";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const NOW = "2026-10-01T06:00:00Z";
const waited: GateRunLocator = { forge: "github", api: "https://api.github.com", repo: "acme/infra", run: "42", attempt: 1 };
const applying: GateRunLocator = { forge: "github", api: "https://api.github.com", repo: "acme/infra", run: "57", attempt: 1 };

const pending = (gate: string, timestamp: string, extra: Partial<PendingGateRecord> = {}): PendingGateRecord => ({
  version: 1,
  kind: "pending",
  op: "tf-apply",
  gate,
  timestamp,
  expiresAt: "2026-10-03T00:00:00Z",
  planDigest: DIGEST,
  resume: waited,
  ...extra,
});
const approval = (gate: string, timestamp: string, by = "alice"): GateResolutionRecord => ({ version: 1, op: "tf-apply", gate, resolvedBy: by, timestamp, planDigest: DIGEST });

const file = (...lines: object[]) => parseAppliedGateFile(lines.map((l) => JSON.stringify(l)).join("\n"));
const appliedLine = (gate: string, approvedAt: string, timestamp: string, extra: Record<string, unknown> = {}) => ({
  version: 1, kind: "applied", op: "tf-apply", gate, planDigest: DIGEST, approvedAt, approvedBy: "alice", timestamp, ...extra,
});

describe("planGateResumes (#3858)", () => {
  test("an approval that answers a standing fact and is not spent: resumable, approved", () => {
    const [c] = planGateResumes({ op: "tf-apply", pending: [pending("wave-1", "2026-10-01T00:00:00Z")], resolutions: [approval("wave-1", "2026-10-01T01:00:00Z")], now: NOW });
    expect(c).toMatchObject({ source: "pending", gate: "wave-1", resumable: true, reason: "approved", approvedBy: "alice", approvedAt: "2026-10-01T01:00:00Z", run: waited });
  });

  test("nothing answers it: not resumable", () => {
    expect(planGateResumes({ op: "tf-apply", pending: [pending("wave-1", "2026-10-01T00:00:00Z")], resolutions: [], now: NOW })).toMatchObject([
      { resumable: false, reason: "not-approved" },
    ]);
  });

  test("an approval a wave already applied under is spent: not resumable, and the report names the apply", () => {
    const lines = file(appliedLine("wave-1", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z", { wave: { number: 1, name: "network" } }));
    const [c] = planGateResumes({ op: "tf-apply", pending: [pending("wave-1", "2026-10-01T00:00:00Z")], resolutions: [approval("wave-1", "2026-10-01T01:00:00Z")], ...lines, now: NOW });
    expect(c).toMatchObject({ resumable: false, reason: "spent", spent: { appliedAt: "2026-10-01T02:00:00Z", approvedAt: "2026-10-01T01:00:00Z", wave: { number: 1 } } });
    expect(c!.message).toContain("spent");
  });

  test("a spent approval of another digest, or an older one, spends nothing here", () => {
    const lines = file(appliedLine("wave-1", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z", { planDigest: OTHER }), appliedLine("wave-1", "2026-09-30T00:00:00Z", "2026-09-30T01:00:00Z"));
    const [c] = planGateResumes({ op: "tf-apply", pending: [pending("wave-1", "2026-10-01T00:00:00Z")], resolutions: [approval("wave-1", "2026-10-01T01:00:00Z")], ...lines, now: NOW });
    expect(c).toMatchObject({ resumable: true, reason: "approved" });
  });

  test("a decision point's answer the gate passes on: answered, unless the resolution citing it is spent", () => {
    const answer = { point: "prod-apply", id: "q-1", path: "points/q-1.json" };
    const fact = pending("wave-1", "2026-10-01T00:00:00Z", { answer });
    const questions = new Map([["q-1", { id: "q-1", state: "answered" as const, answer: true, answeredBy: ["alice"], answeredOn: "2026-10-01T01:00:00Z" }]]);
    expect(planGateResumes({ op: "tf-apply", pending: [fact], resolutions: [], questions, now: NOW })).toMatchObject([{ resumable: true, reason: "answered", approvedBy: "alice" }]);

    const cited: GateResolutionRecord = { ...approval("wave-1", "2026-10-01T03:00:00Z", "alice"), answer };
    const lines = file(appliedLine("wave-1", "2026-10-01T03:00:00Z", "2026-10-01T03:00:01Z"));
    expect(planGateResumes({ op: "tf-apply", pending: [fact], resolutions: [cited], ...lines, questions, now: NOW })).toMatchObject([{ resumable: false, reason: "spent" }]);
  });

  test("an apply that recorded its run and never finished is a stopped apply", () => {
    // terragucci's shape: chant's `applied` line, then the product's `changes` line with the run.
    const lines = file(
      appliedLine("wave-2", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z"),
      appliedLine("wave-2", "2026-10-01T01:00:00Z", "2026-10-01T02:00:01Z", { kind: "changes", resume: applying, changes: [{ address: "aws_s3_bucket.a" }] }),
    );
    const out = planGateResumes({ op: "tf-apply", pending: [pending("wave-2", "2026-10-01T00:00:00Z")], resolutions: [approval("wave-2", "2026-10-01T01:00:00Z")], ...lines, now: NOW });
    expect(out).toMatchObject([
      { source: "pending", reason: "spent", resumable: false },
      { source: "stopped", gate: "wave-2", reason: "stopped", resumable: true, run: applying, approvedBy: "alice", stopped: { appliedAt: "2026-10-01T02:00:01Z", approvedAt: "2026-10-01T01:00:00Z", kind: "changes" } },
    ]);
  });

  test("a finished line, a newer pending fact, or no run locator: not a stopped apply", () => {
    const changes = appliedLine("wave-2", "2026-10-01T01:00:00Z", "2026-10-01T02:00:01Z", { kind: "changes", resume: applying });
    const finished = { version: 1, kind: "finished", op: "tf-apply", gate: "wave-2", planDigest: DIGEST, applied: "2026-10-01T02:00:01Z", result: "failed", timestamp: "2026-10-01T02:30:00Z" };
    const stopped = (lines: ReturnType<typeof file>, p: PendingGateRecord[] = []) =>
      planGateResumes({ op: "tf-apply", pending: p, resolutions: [], ...lines, now: NOW }).filter((c) => c.source === "stopped");
    expect(stopped(file(changes))).toHaveLength(1);
    expect(stopped(file(changes, finished))).toEqual([]);
    expect(stopped(file(changes), [pending("wave-2", "2026-10-01T03:00:00Z")])).toEqual([]);
    expect(stopped(file(appliedLine("wave-2", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z")))).toEqual([]);
    // A newer apply under another approval, with no run, supersedes the stopped one.
    expect(stopped(file(changes, appliedLine("wave-2", "2026-10-01T04:00:00Z", "2026-10-01T05:00:00Z")))).toEqual([]);
  });

  test("a gate filter, and an expired fact, leave facts out", () => {
    const facts = [pending("wave-1", "2026-10-01T00:00:00Z"), pending("wave-2", "2026-10-01T00:00:00Z", { expiresAt: "2026-10-01T05:00:00Z" })];
    expect(planGateResumes({ op: "tf-apply", pending: facts, resolutions: [], now: NOW }).map((c) => c.gate)).toEqual(["wave-1"]);
    expect(planGateResumes({ op: "tf-apply", pending: facts, resolutions: [], now: NOW, gate: "wave-2" })).toEqual([]);
  });

  test("a fact with an approval block needs the tally to be answered", () => {
    const fact = pending("wave-1", "2026-10-01T00:00:00Z", { approval: { mode: "off" } as unknown as PendingGateRecord["approval"] });
    expect(planGateResumes({ op: "tf-apply", pending: [fact], resolutions: [approval("wave-1", "2026-10-01T01:00:00Z")], now: NOW })).toMatchObject([
      { resumable: false, reason: "not-approved", message: expect.stringContaining("tally") },
    ]);
    const answering = () => approval("wave-1", "2026-10-01T01:00:00Z");
    expect(planGateResumes({ op: "tf-apply", pending: [fact], resolutions: [], now: NOW, answering })).toMatchObject([{ resumable: true, reason: "approved" }]);
  });
});
