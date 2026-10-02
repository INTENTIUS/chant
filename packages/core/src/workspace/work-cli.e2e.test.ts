/**
 * #2732 — `chant workspace work claim|renew|release`, run as the CLI: two
 * processes racing for one work item, the lease in `records --json` and
 * `workspace status --json`, and both over MCP.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { McpServer } from "../cli/mcp/server";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import recordsSchema from "./records.schema.json";
import statusSchema from "./status.schema.json";
import workSchema from "./work-lease.schema.json";

const REF = join(REPO, "reference-workspace");
const MAIN = join(REPO, "packages/core/src/cli/main.ts");
const LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;
const CHANT = [process.execPath, "--import", LOADER, MAIN];
const WORK = "work/work.kind.mjs";

function work(id: string, fields: Record<string, unknown> = {}): string {
  const data = { schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: ["path:app/server.mjs"], evidence: [], opened_on: "2026-09-25", source: { kind: "workspace", member: "app" }, supersedes: [], ...fields };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function chant(cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(CHANT[0], [...CHANT.slice(1), ...args], { cwd, env: { ...process.env, NO_COLOR: "1", TSX_DISABLE_CACHE: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const json = (r: Run) => {
  const doc = JSON.parse(r.stdout);
  if ("item" in doc || "error" in doc) contract(workSchema).expectValid(doc);
  return doc;
};

let root: string;
beforeAll(() => {
  root = repo({
    "chant.workspace.json": JSON.stringify(
      {
        name: "studio",
        schema: 1,
        members: [{ name: "app", dir: "app", kind: "other", because: "a plain Node server" }],
        records: [{ kind: "decisions/decision.kind.mjs" }, { kind: WORK }],
      },
      null,
      2,
    ),
    "app/server.mjs": "export const port = 8080;\n",
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "work/W-001-server.md": work("W-001"),
    "work/W-002-next.md": work("W-002"),
    "work/W-003-done.md": work("W-003", { state: "done", closed_on: "2026-09-25", evidence: [{ title: "The review", url: "https://example.com/review" }] }),
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the queue");
});
afterAll(cleanScratch);

describe("chant workspace work (#2732)", () => {
  test("two processes claiming one work item: one wins, and the other is refused with the holder named", async () => {
    const [a, b] = await Promise.all([
      chant(root, ["workspace", "work", "claim", "W-001", "--holder", "worker-a", "--ttl", "600", "--json"]),
      chant(root, ["workspace", "work", "claim", "W-001", "--holder", "worker-b", "--ttl", "600", "--json"]),
    ]);
    const runs = [a, b];
    const won = runs.filter((r) => r.code === 0);
    const lost = runs.filter((r) => r.code === 2);
    expect(won, `${a.stderr}\n${b.stderr}`).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = json(won[0]);
    expect(winner).toMatchObject({ item: "W-001", event: "claim", kind: WORK, ref: "refs/chant/lease/work/W-001", history: { path: "_leases/W-001.jsonl" } });
    const refusal = json(lost[0]);
    expect(refusal.refused.heldBy.holder).toBe(winner.lease.holder);
    expect(refusal.refused.code).toMatch(/^lease-(held|race)$/);
    expect(refusal.refused.message).toContain(winner.lease.holder);
    expect(git(root, "show", "chant/lifecycle:_leases/W-001.jsonl").split("\n")).toHaveLength(1);
  }, 120_000);

  test("records --json gives each work item its active lease, and status --json lists active and expired leases", async () => {
    const claim = await chant(root, ["workspace", "work", "claim", "W-002", "--holder", "worker-c", "--ttl", "1", "--json"]);
    expect(claim.code, claim.stderr).toBe(0);
    await new Promise((r) => setTimeout(r, 1_100));

    const records = await chant(root, ["workspace", "records", "--kind", WORK, "--json"]);
    expect(records.code, records.stderr).toBe(0);
    const doc = json(records);
    contract(recordsSchema).expectValid(doc);
    const byId = new Map((doc.records as { id: string; lease?: unknown }[]).map((r) => [r.id, r.lease]));
    expect(byId.get("W-001")).toMatchObject({ holder: expect.stringMatching(/^worker-[ab]$/) });
    expect(byId.get("W-002")).toBeNull(); // expired, so not active
    expect(byId.get("W-003")).toBeNull();

    const status = await chant(root, ["workspace", "status", "dev", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    const sdoc = json(status);
    contract(statusSchema).expectValid(sdoc);
    expect(sdoc.leases.map((l: { item: string; state: string; member: string | null }) => [l.item, l.state, l.member])).toEqual([
      ["W-001", "active", null],
      ["W-002", "expired", null],
    ]);

    // An expired lease can be claimed again, with a new token.
    const again = await chant(root, ["workspace", "work", "claim", "W-002", "--holder", "worker-d", "--json"]);
    expect(again.code, again.stderr).toBe(0);
    expect(json(again).lease.token).not.toBe(json(claim).lease.token);
  }, 120_000);

  test("renew keeps the token and moves the expiry; release frees the item; the history has a line for each", async () => {
    const claim = json(await chant(root, ["workspace", "work", "claim", "W-001", "--holder", "nobody", "--json"]));
    const holder = claim.refused.heldBy.holder as string;
    const token = claim.refused.heldBy.token as string;

    const renew = await chant(root, ["workspace", "work", "renew", "W-001", "--holder", holder, "--token", token, "--ttl", "20m", "--json"]);
    expect(renew.code, renew.stderr).toBe(0);
    const renewed = json(renew).lease;
    expect(renewed.token).toBe(token);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(claim.refused.heldBy.expiresAt));

    const wrong = await chant(root, ["workspace", "work", "release", "W-001", "--holder", "nobody", "--json"]);
    expect(wrong.code).toBe(2);
    expect(json(wrong).refused.code).toBe("lease-held");

    const release = await chant(root, ["workspace", "work", "release", "W-001", "--holder", holder, "--outcome", "done"]);
    expect(release.code, release.stderr).toBe(0);
    expect(release.stdout).toContain("W-001 released by");

    const events = git(root, "show", "chant/lifecycle:_leases/W-001.jsonl").split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.event)).toEqual(["claim", "renew", "release"]);
    expect(events[2]).toMatchObject({ holder, by: holder, outcome: "done", token });
  }, 120_000);

  test("an unknown item, a closed item and a bad verb are errors, not refusals", async () => {
    const unknown = await chant(root, ["workspace", "work", "claim", "W-999", "--holder", "a", "--json"]);
    expect(unknown.code).toBe(1);
    expect(json(unknown).error.code).toBe("work-item-unknown");
    const closed = await chant(root, ["workspace", "work", "claim", "W-003", "--holder", "a", "--json"]);
    expect(closed.code).toBe(1);
    expect(json(closed).error.code).toBe("work-item-closed");
    const verb = await chant(root, ["workspace", "work", "grab", "W-001", "--holder", "a"]);
    expect(verb.code).toBe(1);
    expect(verb.stderr).toContain("claim, renew, release or history");
    const noHolder = await chant(root, ["workspace", "work", "claim", "W-001"]);
    expect(noHolder.code).toBe(1);
    expect(noHolder.stderr).toContain("--holder");
  }, 120_000);

  test("the lease fields reach an MCP client through workspace-records and workspace-status", async () => {
    const claim = await chant(root, ["workspace", "work", "claim", "W-001", "--holder", "mcp-worker", "--json"]);
    expect(claim.code, claim.stderr).toBe(0);
    const server = new McpServer([], { workspace: { cwd: root, chantCommand: CHANT } });
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (res.result as { structuredContent: Record<string, unknown> }).structuredContent;
    };
    const records = (await call("workspace-records", { kind: WORK })) as { records: { id: string; lease: { holder: string } | null }[] };
    expect(records.records.find((r) => r.id === "W-001")?.lease?.holder).toBe("mcp-worker");
    const status = (await call("workspace-status", { env: "dev" })) as { leases: { item: string; holder: string; state: string }[] };
    expect(status.leases.find((l) => l.item === "W-001")).toMatchObject({ holder: "mcp-worker", state: "active" });
  }, 120_000);
});
