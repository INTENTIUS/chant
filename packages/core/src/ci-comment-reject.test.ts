/**
 * #5354: `/<product> reject <reason>` records a rejection of the release a
 * stage waits on when the stage's approval mode takes the comment author's
 * forge identity, and replies with the reject line where it needs proof a
 * comment cannot carry.
 */

import { describe, expect, test } from "vitest";
import { answerProductComment, type AnswerCommentOptions } from "./ci-comment-commands";
import { chantNoteRuns } from "./ci-note-commands";
import type { CommentReject } from "./ci-comment-reject";
import { assertProductWords, parseProductComment } from "./ci-product-words";
import { memoryGateLedgerPort } from "./op/gate";
import { gateRejections } from "./op/gate-reject";
import type { PendingGateRecord } from "./lifecycle/gate-ledger";
import type { GateSigners } from "./lifecycle/gate-seal";
import { emptyPolicy } from "./workspace/trust/policy";
import { asPipelineSpec, type PipelineGate } from "./pipeline/spec";
import type { ForgeReads } from "./pr-forge-reads";

const RELEASE = "sha256:" + "9".repeat(64);
const words = assertProductWords({ product: "plywood", op: "shop", commands: { up: "apply", reject: "reject" } });

const pending: PendingGateRecord = {
  version: 1,
  kind: "pending",
  op: "shop",
  gate: "staging",
  timestamp: "2026-11-20T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  planDigest: RELEASE,
  environment: "staging",
};

function world(gate: PipelineGate, permission = "write") {
  const port = memoryGateLedgerPort({ pending: [pending] });
  const wave = (target: string) => [{ name: target, runs: [{ target }] }];
  const spec = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: wave("dev") }, { name: "staging", waves: wave("staging"), gate }] });
  const reject: CommentReject = {
    pipeline: async () => spec,
    port,
    principal: (login) => `github:${login}`,
    scope: async () => ({ declaration: null, policy: emptyPolicy(null), rule: null, signers: emptyPolicy(null) }),
    now: () => "2026-11-20T01:00:00.000Z",
  };
  const posted: string[] = [];
  const opts: AnswerCommentOptions = {
    forge: "github",
    event: {
      action: "created",
      comment: { id: 7, body: "/plywood reject the migration locks the orders table", user: { login: "alice" }, html_url: "https://github.com/acme/shop/pull/12#issuecomment-7" },
      issue: { number: 12, pull_request: {} },
      repository: { full_name: "acme/shop", default_branch: "main" },
      sender: { login: "alice" },
    },
    repo: "acme/shop",
    reads: { kind: "github", permission: async () => permission } as unknown as ForgeReads,
    poster: { addComment: async (_n: number, text: string) => (posted.push(text), { id: 1 } as never), commitStatuses: async () => [] as never },
    runs: { rerunFailed: async () => ({}), dispatch: async () => ({}) },
    words,
    base: "main",
    jobs: {},
    reject,
  };
  return { opts, port, posted };
}

describe("a reject comment", () => {
  test("parses its reason and an optional stage", () => {
    expect(parseProductComment(words, "/plywood reject the table locks")).toEqual({ kind: "reject", reason: "the table locks" });
    expect(parseProductComment(words, "/plywood reject --stage staging the table locks")).toEqual({ kind: "reject", stage: "staging", reason: "the table locks" });
    expect(parseProductComment(words, "/plywood reject")).toMatchObject({ kind: "refused" });
  });

  test.each(["ledger", "pr-review", "pull-request"] as const)("under %s it records the author's rejection under their forge identity, bound to the pending fact's digest", async (mode) => {
    const w = world({ approval: mode });
    const out = await answerProductComment(w.opts);
    expect(out).toMatchObject({ command: "reject", ran: true, replied: true });
    expect(w.port.rejections).toEqual([
      expect.objectContaining({ op: "shop", gate: "staging", rejectedBy: "github:alice", planDigest: RELEASE, environment: "staging", reason: "the migration locks the orders table", url: "https://github.com/acme/shop/pull/12#issuecomment-7", approver: { kind: "human" } }),
    ]);
    expect(w.posted[0]).toContain("recorded github:alice's rejection of");
    // The promote then counts it under the stage's mode.
    expect(gateRejections(w.port.rejections, { gate: "staging", planDigest: RELEASE, environment: "staging", mode, signers: emptyPolicy(null) as GateSigners, roles: {} }).standing).toHaveLength(1);
  });

  test("under sealed it records nothing, and the reply names the reject line and why", async () => {
    const w = world({ approval: "sealed" });
    const out = await answerProductComment(w.opts);
    expect(out).toMatchObject({ ran: false, replied: true });
    expect(w.port.rejections).toEqual([]);
    expect(w.posted[0]).toBe(`plywood: stage staging counts only sealed approvals, so it counts only a sealed rejection, which a comment cannot carry. Run \`plywood reject shop staging --plan ${RELEASE} --reason <why> --sign\``);
  });

  test("a stage whose rules need a proven approver records nothing, and says so", async () => {
    const w = world({ quorum: [{ count: 1, roles: ["release-manager"] }] });
    await answerProductComment(w.opts);
    expect(w.port.rejections).toEqual([]);
    expect(w.posted[0]).toContain("counts only a proven approver, which a comment cannot show");
  });

  test("a commenter without write access records nothing and gets no reply", async () => {
    const w = world({}, "read");
    const out = await answerProductComment(w.opts);
    expect(out).toMatchObject({ ran: false, replied: false, reason: "alice has no write access, so the comment is ignored" });
    expect(w.port.rejections).toEqual([]);
    expect(w.posted).toEqual([]);
  });

  test("a job with no reject set up replies with the reject line and records nothing", async () => {
    const w = world({});
    const { reject: _r, ...opts } = w.opts;
    await answerProductComment(opts);
    expect(w.port.rejections).toEqual([]);
    expect(w.posted[0]).toBe("plywood: this repository records no rejection from a comment: run `plywood reject shop <stage> --plan <digest> --reason <why> --sign`");
  });

  test("a GitLab note records the same way, after the poll's role check", async () => {
    const w = world({ approval: "pr-review" });
    const runs = chantNoteRuns({}, { reject: w.opts.reject! });
    const parsed = parseProductComment(words, "/plywood reject --stage staging not this one")!;
    const done = await runs({ mr: { number: 3, state: "open", sameRepo: true } as never, note: { id: 1, body: "", author: "bob" } as never, parsed: parsed as never, base: "main", words });
    expect(done).toMatchObject({ kind: "reply", text: expect.stringContaining("recorded github:bob's rejection") });
    expect(w.port.rejections[0]).toMatchObject({ rejectedBy: "github:bob", reason: "not this one" });
  });
});
