/**
 * The why chain of `graph --intent` (#4023), from work item to production
 * release. Everything runs in a temp repo with no remote, so nothing is
 * pushed: a workspace with a work item, a commit whose trailer links it, a
 * green tag, a real cut, a real `components promote --release` into prod that
 * stops at its release gate, a real `chant approve`, and the promote that
 * follows. Only the capability registry is replaced, so no deploy step
 * reaches a cloud, and the member's graph, so the resource node resolves to
 * its component file without building the member.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityRegistry, type DeployContext } from "../../components/capability";
import type { DriverComponent } from "../../components/driver";
import type { ParsedArgs } from "../registry";
import { appendReleaseRecord, readReleaseLedger } from "../../lifecycle/release-ledger";
import { readGateLedger } from "../../lifecycle/gate-ledger";
import { cutRelease } from "../../lifecycle/release-cut";
import { resetGateOrigin } from "../../lifecycle/gate-origin";
import { contract, REPO } from "../../workspace/__fixtures__/contract-repo";
import { intentGraph, type IntentDocument } from "../../workspace/intent";
import intentSchema from "../../workspace/intent.schema.json";
import type { ReleaseArtifact } from "../../lifecycle/release-store";
import type { CompiledTarget, TargetCompiler } from "../../components/release-compile";

const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;

const api: DriverComponent = {
  name: "api",
  deploy: [
    { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar" }] },
    { phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "apply", template: "dist/api.template.json", imageRef: "@Publish.digest" }] },
  ],
};

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => ({ config: {} }) };
});
vi.mock("../../components/cli-support", () => ({
  isComponentList: () => false,
  resolveComponentTargets: async () => ({ success: true, targets: [api] }),
}));
vi.mock("../../components/fan-out-support", () => ({
  fanOutRegistry: async () => {
    const registry = new CapabilityRegistry();
    registry.register({ kind: "publish-image", async run(_ctx: DeployContext) { return { digest: DIGEST, uri: `reg/api@${DIGEST}` }; } } as never);
    registry.register({ kind: "apply", async run() { return {}; } } as never);
    return registry;
  },
}));
vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));
vi.mock("./run", () => ({ GATED_EXIT_CODE: 3 }));

const { runComponentsPromote } = await import("./promote");
const { recordGateApproval } = await import("./approve");

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A compiler that compiles each environment to its own template and builds one image. */
const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return {
      env,
      params: [],
      components: ["api"],
      buildSteps: { api: [{ kind: "docker-build", context: "api", into: "api.tar" }] },
      buildInputs: { api: ["api"] },
      componentFiles: { api: "api.component.ts" },
      templates: [{ component: "api", path: "dist/api.template.json", content: `{"env":"${env}"}\n` }],
    };
  },
  async buildArtifacts(_env, components): Promise<ReleaseArtifact[]> {
    return components.map((c) => ({ component: c, kind: "image" as const, path: `${c}.tar`, digest: DIGEST }));
  },
};

function args(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    command: "components", path: "promote", format: "", fix: false, watch: false, verbose: false, help: false, live: false,
    migrateFrom: "staging", migrateTo: "prod", actor: "bob", runId: "run-9", ...overrides,
  } as ParsedArgs;
}
const ctx = (a: Partial<ParsedArgs>) => ({ args: args(a), plugins: [] }) as never;

const REF = join(REPO, "reference-workspace");
const KIND_FILES: Record<string, string> = {
  "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
  "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
  "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
  "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
};
const W001 = `---\n${JSON.stringify({ schema: 1, id: "W-001", title: "Ship the api to prod", state: "open", implements: [], needs: [], constrains: ["path:api.component.ts"], evidence: [], opened_on: "2026-10-16", supersedes: [] }, null, 2)}\n---\n\n# W-001\n`;
const DECLARATION = JSON.stringify({ name: "shop", schema: 1, members: [{ name: "api", dir: ".", kind: "other", because: "the api and its component" }] });
const intent = contract(intentSchema);
type Result = Exclude<IntentDocument, { error: unknown }>;

describe("the why chain from work item to production release (#4023)", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    resetGateOrigin();
    vi.restoreAllMocks();
  });

  test(
    "the trace from the api's resource node walks W-001, the linked commit, its green tag, the cut, the release gate approval and the prod deploy",
    async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await withTestDir(async (dir) => {
        git(dir, "init", "-q", "-b", "main");
        git(dir, "config", "user.email", "t@chant.dev");
        git(dir, "config", "user.name", "T");
        const files: Record<string, string> = {
          "chant.workspace.json": DECLARATION,
          "chant.config.ts": `export default { environments: ["dev", "staging", "prod"] };\n`,
          "api.component.ts": "export const api = {};\n",
          "work/W-001-ship.md": W001,
          ...KIND_FILES,
        };
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(join(dir, path, ".."), { recursive: true });
          writeFileSync(join(dir, path), text);
        }
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "the api and W-001");
        // The work: a commit whose trailer names W-001, made green.
        writeFileSync(join(dir, "api.component.ts"), "export const api = { port: 8081 };\n");
        git(dir, "commit", "-q", "-am", "serve the api on 8081", "--trailer", "Chant-Record: work:W-001");
        const sha = git(dir, "rev-parse", "HEAD");
        git(dir, "tag", `ci/green/${sha}`, sha);
        process.chdir(dir);

        // The release is cut from the green commit, and promoted to prod through its release gate.
        const cut = await cutRelease({ cwd: dir, compiler, label: "v1.0.0", actor: "alice", env: {}, now: () => new Date("2026-10-16T10:00:00.000Z") });
        const releaseDigest = cut.release.releaseDigest;
        await appendReleaseRecord({ component: "api", env: "staging", digest: DIGEST, gitSha: sha, runId: "run-1", timestamp: "2026-10-16T10:30:00.000Z", actor: "ci" }, { cwd: dir });
        expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(3);
        expect((await recordGateApproval("release", "prod-release", { origin: "cli", actor: "alice", cwd: dir, environment: "prod" })).ok).toBe(true);
        expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(0);
        const [deploy] = (await readReleaseLedger("prod", { cwd: dir })).records;
        const [resolution] = (await readGateLedger("release", { cwd: dir })).resolutions;

        const walk = async (region: string): Promise<Result> => {
          const { doc } = await intentGraph({
            cwd: dir,
            region,
            kinds: [join(dir, "work/work.kind.mjs")],
            resolveNode: async (_cwd, _at, member, id) => (member === "api" && id === "api/api" ? { file: "api.component.ts", line: null } : null),
          });
          intent.expectValid(doc);
          if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
          return doc;
        };

        // From the resource node: who asked for it, and who let it ship, in one read.
        const doc = await walk("api/api");
        expect(doc.nodes[0]).toMatchObject({ kind: "region", path: "api.component.ts", node: "api/api" });
        const trace = doc.trace!;
        expect(trace.reasons).toEqual([]);
        const c = trace.commits.find((x) => x.sha === sha)!;
        expect(c.work).toEqual({ state: "linked", items: [{ id: "work:W-001", node: "record:work/W-001", source: { ref: sha, field: "Chant-Record", value: "work:W-001" } }], problems: [] });
        expect(c.tag).toMatchObject({ state: "green", green: { tag: `ci/green/${sha}` } });
        expect(c.releases).toEqual([{ release: releaseDigest, link: "cut-from", source: { ref: `chant/lifecycle:_releases/${releaseDigest.replace(/:/g, "_")}.json`, field: "commit", value: sha } }]);
        expect(c.deploys.map((d) => [d.env, d.link])).toEqual([["prod", "built-from"], ["staging", "built-from"]]);

        const [release] = trace.releases;
        expect(trace.releases).toHaveLength(1);
        expect(release).toMatchObject({ releaseDigest, label: "v1.0.0", commit: sha, tag: { state: "green" }, cuts: [{ label: "v1.0.0", actor: "alice" }] });
        // The gate approval: who, on which channel, when, and the change set the promote stored for it (#4022).
        expect(release.gates).toEqual([
          expect.objectContaining({ op: "release", gate: "prod-release", environment: "prod", resolvedBy: "alice", channel: "cli", at: resolution.timestamp, planDigest: resolution.planDigest, changeSet: resolution.planDigest, empty: false }),
        ]);
        expect(release.gates[0].changeSetSource).toEqual({ ref: `chant/lifecycle:_change-sets/${resolution.planDigest!.replace(/:/g, "_")}.json`, field: "planDigest", value: resolution.planDigest });

        // The prod deploy record, admitted by that resolution.
        const prod = trace.deploys.find((d) => d.env === "prod")!;
        expect(release.deploys).toEqual([prod.id]);
        expect(prod).toMatchObject({ component: "api", runId: deploy.runId, gitSha: sha, release: releaseDigest, approver: "alice", admittedBy: { op: "release", gate: "prod-release", resolvedBy: "alice", at: resolution.timestamp } });
        // Staging was a plain deploy of the same commit: it names no release.
        expect(trace.deploys.find((d) => d.env === "staging")).toMatchObject({ release: null, admittedBy: null });

        // The same chain from the commit itself.
        const byCommit = await walk(sha);
        expect(byCommit.trace!.commits).toEqual([c]);
        expect(byCommit.trace!.releases).toEqual(trace.releases);
      });
    },
    240_000,
  );
});
