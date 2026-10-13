/**
 * `chant workspace check --live --env <env>` (#2549, ws-062): declared member
 * links resolved against the live graph of each producer. A fake chant stands
 * in for the member's own toolchain: it prints ir.json for a source read and
 * live.json for `--live`, and records its command line in argv.txt.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { cleanScratch, contract, declaration, repo } from "./__fixtures__/contract-repo";
import { parseArgs } from "../cli/main";
import schema from "./check.schema.json";
import { workspaceGraph } from "./graph-cli";
import { runChecks, runWorkspaceCheck } from "./lineage-check";
import type { CheckDocument } from "./lineage-check";

const { expectValid } = contract(schema);

afterAll(() => cleanScratch());
afterEach(() => vi.restoreAllMocks());

const FAKE_CHANT = `#!/bin/sh
[ "$1" = graph ] || { echo "Error: Unknown command: $1" >&2; exit 1; }
printf '%s\\n' "$*" > ../argv.txt
case " $* " in
  *" --live "*) cat live.json ;;
  *) cat ir.json ;;
esac
`;

const graph = (exports: { name: string; value?: unknown }[]) => JSON.stringify({ version: 1, nodes: [], edges: [], groups: {}, exports });

function workspace(live: { name: string; value?: unknown }[], links: unknown[], producerKind: "chant" | "other" = "chant", extra: Record<string, unknown> = {}) {
  return repo({
    "chant.workspace.json": declaration([
      producerKind === "chant" ? { name: "api", dir: "api", kind: "chant" } : { name: "api", dir: "api", kind: "other", because: "a queue made by hand", outputs: ["QueueUrl"] },
      { name: "web", dir: "web", kind: "other", because: "a static site", links },
    ], extra),
    "api/chant.config.ts": "export default {};\n",
    "api/ir.json": graph([{ name: "QueueUrl" }, { name: "TopicArn" }]),
    "api/live.json": graph(live),
    "web/index.html": "",
    ".gitignore": "node_modules\n",
    "node_modules/.bin/chant": { text: FAKE_CHANT, mode: 0o755 },
  });
}

async function live(root: string, env = "prod") {
  const doc = (await runChecks(root, undefined, { live: { env } })) as Extract<CheckDocument, { workspace: unknown }>;
  const diagnostics = doc.declaration!.diagnostics.filter((d) => d.ruleId === "WSP141" || d.ruleId === "WSP142");
  return { doc, diagnostics, rows: doc.declaration!.live?.links ?? [] };
}

describe("check --live (#2549)", () => {
  test("a link to an output the live graph publishes resolves, and the row says it resolved live", async () => {
    const root = workspace([{ name: "QueueUrl", value: "https://q" }], [{ member: "api", output: "QueueUrl" }]);
    const { doc, diagnostics, rows } = await live(root);
    expect(diagnostics).toEqual([]);
    expectValid(doc);
    expect(doc.declaration!.live!.env).toBe("prod");
    expect(rows).toMatchObject([{ consumer: "web", producer: "api", output: "QueueUrl", resolves: "live", status: "resolved", reason: null }]);
    // The member ran as `chant graph --live --env prod`.
    expect(readFileSync(join(root, "argv.txt"), "utf-8")).toContain("--env prod --live");
  });

  test("an output the producer declares but its estate does not publish is WSP141, a warning", async () => {
    const root = workspace([{ name: "TopicArn", value: "arn" }], [{ member: "api", output: "QueueUrl" }]);
    const { diagnostics, rows } = await live(root);
    expect(rows[0]).toMatchObject({ status: "missing", resolves: "live" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ ruleId: "WSP141", severity: "warning", entity: "web" });
    expect(diagnostics[0].message).toContain("does not resolve live in prod");
    expect(diagnostics[0].message).toContain("TopicArn");
  });

  test("a live read that returned no outputs at all leaves the link unresolved, not missing", async () => {
    const root = workspace([], [{ member: "api", output: "QueueUrl" }]);
    const { diagnostics, rows } = await live(root);
    expect(rows[0].status).toBe("unresolved");
    expect(diagnostics).toMatchObject([{ ruleId: "WSP142", severity: "info" }]);
    expect(diagnostics[0].message).toContain("returned no outputs");
  });

  test("a producer of a kind chant does not read live is kept unresolved, with the reason", async () => {
    const root = workspace([], [{ member: "api", output: "QueueUrl" }], "other");
    const { diagnostics, rows } = await live(root);
    expect(rows[0]).toMatchObject({ status: "unresolved", resolves: "live" });
    expect(diagnostics).toMatchObject([{ ruleId: "WSP142" }]);
    expect(diagnostics[0].message).toContain("kind other");
  });

  test("a telemetry link is not resolved live", async () => {
    const root = workspace([{ name: "QueueUrl" }], [{ member: "api", output: "traces", kind: "telemetry" }]);
    const { rows } = await live(root);
    expect(rows).toEqual([]);
  });

  test("severity settings apply to the live checks like any other", async () => {
    const root = repo({
      "chant.workspace.json": declaration(
        [
          { name: "api", dir: "api", kind: "chant" },
          { name: "web", dir: "web", kind: "other", because: "a static site", links: [{ member: "api", output: "QueueUrl" }], suppress: [{ check: "WSP141", because: "deployed next week" }] },
        ],
        { checks: { WSP141: "error" } },
      ),
      "api/chant.config.ts": "export default {};\n",
      "api/ir.json": graph([{ name: "QueueUrl" }]),
      "api/live.json": graph([{ name: "Other" }]),
      "web/index.html": "",
      ".gitignore": "node_modules\n",
      "node_modules/.bin/chant": { text: FAKE_CHANT, mode: 0o755 },
    });
    const { doc, diagnostics } = await live(root);
    expect(diagnostics).toEqual([]);
    expect(doc.declaration!.suppressed.map((s) => s.ruleId)).toContain("WSP141");
  });

  test("without --live no member runs and the report has no live section", async () => {
    const root = workspace([{ name: "QueueUrl" }], [{ member: "api", output: "QueueUrl" }]);
    const doc = (await runChecks(root)) as Extract<CheckDocument, { workspace: unknown }>;
    expect(doc.declaration!.live).toBeUndefined();
    expect(existsSync(join(root, "argv.txt"))).toBe(false);
  });
});

describe("the command (#2549)", () => {
  async function run(root: string, argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const code = await runWorkspaceCheck({ args: parseArgs(["workspace", "check", ...argv]), plugins: [] } as never);
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  test("--live needs --env, and takes no --at, and runs no member when it refuses", async () => {
    const root = workspace([{ name: "QueueUrl" }], [{ member: "api", output: "QueueUrl" }]);
    const noEnv = await run(root, ["--live"]);
    expect(noEnv.code).toBe(1);
    expect(noEnv.err).toContain("--live needs an environment");
    const atRev = await run(root, ["--live", "--env", "prod", "--at", "HEAD"]);
    expect(atRev.code).toBe(1);
    expect(atRev.err).toContain("--at");
    expect(existsSync(join(root, "argv.txt"))).toBe(false);
  });

  test("--live --json prints the live section, and a WSP141 warning leaves the exit code 0", async () => {
    // The fake producer's source lists no outputs, so the source check WSP093 is turned off; the live warning is the one under test.
    const root = workspace([{ name: "TopicArn" }], [{ member: "api", output: "QueueUrl" }], "chant", { checks: { WSP093: "off" } });
    const { code, out } = await run(root, ["--live", "--env", "prod", "--json"]);
    const report = JSON.parse(out) as { declaration: { live: { env: string; links: { status: string }[] }; diagnostics: { ruleId: string }[] } };
    expect(report.declaration.live).toMatchObject({ env: "prod", links: [{ status: "missing" }] });
    expect(report.declaration.diagnostics.map((d) => d.ruleId)).toContain("WSP141");
    expect(code).toBe(0);
  });
});

describe("the design member kind (#2549, ws-062)", () => {
  const designWorkspace = (extra: Record<string, unknown> = {}) =>
    repo({
      "chant.workspace.json": declaration([
        { name: "design", dir: "design", kind: "design", outputs: ["screens/home.json"], ...extra },
        { name: "web", dir: "web", kind: "other", because: "a static site", links: [{ member: "design", output: "screens/home.json" }] },
      ]),
      "design/screens/home.json": "{}\n",
      "web/index.html": "",
    });

  test("is a declared kind: no WSP003, no WSP009, no `because` needed, and its listed outputs are link targets", async () => {
    const doc = (await runChecks(designWorkspace())) as Extract<CheckDocument, { workspace: unknown }>;
    const ids = doc.declaration!.diagnostics.map((d) => d.ruleId);
    expect(ids).not.toContain("WSP003");
    expect(doc.declaration!.diagnostics.filter((d) => d.entity === "design")).toEqual([]);
    expect(doc.declaration!.links).toMatchObject([{ consumer: "web", producer: "design", output: "screens/home.json", status: "resolved" }]);
  });

  test("a data member: workspace graph reads it and builds nothing, saying so", async () => {
    const { doc } = await workspaceGraph({ cwd: designWorkspace() });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.members.find((m) => m.name === "design")).toMatchObject({ kind: "design", status: "skipped", reason: { code: "kind-not-run" } });
    expect(doc.members.find((m) => m.name === "design")!.reason!.message).toContain("data");
  });

  test("a design member's link is not resolved live: its files are not an estate", async () => {
    const { rows, diagnostics } = await live(designWorkspace());
    expect(rows[0]).toMatchObject({ status: "unresolved", resolves: "live" });
    expect(diagnostics).toMatchObject([{ ruleId: "WSP142" }]);
  });
});
