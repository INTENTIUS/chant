import { describe, expect, test } from "vitest";
import { gatedRequestDigest, gatedRequestOf } from "./gated-request-digest";
import { parseGateLedger } from "./gate-ledger";
import { loadQueryData } from "./query";
import type { LedgerReadPort } from "./ledger-port";

function port(files: Record<string, string>): LedgerReadPort {
  return {
    read: async (dir, file) => files[`${dir}/${file}`] ?? null,
    list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
    trees: async () => [...new Set(Object.keys(files).map((p) => p.slice(0, p.indexOf("/"))))],
  };
}
const lines = (...rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const request = { kind: "state-export", subject: "network", by: "github:alice", at: "2026-10-27T10:00:00Z", fields: { location: "s3://b/k", version_id: "v1" } };

describe("gated requests (#4551)", () => {
  test("the digest binds the op and every field, whatever their order", () => {
    const d = gatedRequestDigest("tf-export", request);
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(gatedRequestDigest("tf-export", { ...request, fields: { version_id: "v1", location: "s3://b/k" } })).toBe(d);
    expect(gatedRequestDigest("tf-unlock", request)).not.toBe(d);
    expect(gatedRequestDigest("tf-export", { ...request, fields: { ...request.fields, version_id: "v2" } })).not.toBe(d);
  });

  test("a pending fact keeps a request of the right shape and drops one of the wrong shape", () => {
    expect(gatedRequestOf(request)).toEqual(request);
    expect(gatedRequestOf({ ...request, fields: { n: 1 } })).toBeUndefined();
    const fact = { version: 1, kind: "pending", op: "tf-export", gate: "network", timestamp: "2026-10-27T10:00:01Z", expiresAt: "2026-10-29T10:00:01Z", planDigest: gatedRequestDigest("tf-export", request) };
    const { pending } = parseGateLedger(lines({ ...fact, request, changeSet: "jcs1-sha256:aa" }, { ...fact, request: { kind: 1 }, changeSet: 7 }));
    expect(pending[0]).toMatchObject({ request, changeSet: "jcs1-sha256:aa" });
    expect(pending[1]).not.toHaveProperty("request");
    expect(pending[1]).not.toHaveProperty("changeSet");
  });

  test("chant query reads applies with their finished line, pull request environments, and the new gate and run columns", async () => {
    const digest = gatedRequestDigest("tf-export", request);
    const { data } = await loadQueryData([{ member: null, port: port({
      "_gates/tf-export.jsonl": lines({ version: 1, kind: "pending", op: "tf-export", gate: "network", timestamp: "2026-10-27T10:00:01Z", expiresAt: "2026-10-29T10:00:01Z", planDigest: digest, request }),
      "_gates/tf-export/applied.jsonl": lines(
        { version: 1, kind: "applied", op: "tf-export", gate: "network", planDigest: digest, approvedAt: "2026-10-27T11:00:00Z", approvedBy: "github:bob", timestamp: "2026-10-27T11:05:00Z" },
        { version: 1, kind: "finished", op: "tf-export", gate: "network", planDigest: digest, applied: "2026-10-27T11:05:00Z", result: "applied", timestamp: "2026-10-27T11:06:00Z", detail: { content_digest: "sha256:cc" } },
      ),
      "_pr-envs/records.jsonl": lines({ version: 1, kind: "up", pr: 12, env: "pr-12", template: "staging", marker: { stack: "app", env: "pr-12" }, commit: "a".repeat(40), components: ["api"], planDigest: "jcs1-sha256:p", result: "applied", by: "ci", timestamp: "2026-10-27T12:00:00Z", releaseTarget: false }),
      "local/runs__tf-apply.jsonl": lines({ version: 1, id: "r1", op: "tf-apply", env: "local", started: "2026-10-27T09:00:00Z", ended: "2026-10-27T09:01:00Z", status: "ok", labels: {}, outcomes: {}, phases: [], wave: { spec: "tf-apply", number: 1, name: "network", job: "wave", digest: "jcs1-sha256:w", exitCode: 0, applied: ["network"], failed: [], moved: [] } }),
    }) }]);
    expect(data.applies).toEqual([expect.objectContaining({ op: "tf-export", gate: "network", plan_digest: digest, approved_by: "github:bob", result: "applied", finished_at: "2026-10-27T11:06:00Z", detail: JSON.stringify({ content_digest: "sha256:cc" }) })]);
    expect(data.pr_envs).toEqual([expect.objectContaining({ kind: "up", pr: 12, env: "pr-12", result: "applied" })]);
    expect(JSON.parse(String(data.gates[0]!.request))).toEqual(request);
    expect(JSON.parse(String(data.runs[0]!.wave))).toMatchObject({ spec: "tf-apply", digest: "jcs1-sha256:w" });
  });
});
