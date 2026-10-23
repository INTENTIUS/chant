/**
 * Running a pull request's environment over an adapter (#4330): the gate,
 * the records, the ownership check and the sweep come from chant, and the
 * plan, apply and teardown from the adapter, as terragucci supplies them for
 * Terraform roots under suffixed state keys. Test values only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { ObservationLexicon, TeardownCandidate } from "../lexicon";
import {
  PR_ENV_TEARDOWN_ENV,
  commandTeardownAdapter,
  prEnvDown,
  prEnvSweep,
  prEnvUp,
  readTeardownEnumeration,
  type PrEnvAdapter,
  type PrEnvApproval,
  type PrEnvPorts,
} from "./pr-env-run";
import { livePrEnvironments, prEnvironmentSite, renderPrEnvNote, type PrEnvRecord, type PrEnvReport, type PrEnvTeardownAdapter } from "./pr-environment";

const HEAD = "b".repeat(40);
const NOW = new Date("2026-10-23T10:00:00.000Z");

/** In-memory ports: the records, a gate that answers as told, and what was published. */
function ports(approval: PrEnvApproval = { status: "pending" }, records: PrEnvRecord[] = [], state?: Record<number, "open" | "closed" | "merged">): PrEnvPorts & { records: PrEnvRecord[]; published: PrEnvReport[]; asked: string[] } {
  const published: PrEnvReport[] = [];
  const asked: string[] = [];
  return {
    records,
    published,
    asked,
    async readRecords() {
      return [...records];
    },
    async appendRecord(r) {
      records.push(r);
    },
    async decideGate(input) {
      asked.push(`${input.op} ${input.gate} ${input.digest}`);
      return approval;
    },
    async publish(r) {
      published.push(r);
    },
    ...(state ? { pullRequestState: async (pr: number) => state[pr] ?? "open" } : {}),
  };
}

/** A Terraform-like adapter: two roots, each copied under a state key suffixed -pr-<n>. */
function roots(opts: { changes?: number; failPlan?: boolean } = {}): PrEnvAdapter & { applied: string[] } {
  const applied: string[] = [];
  const changes = opts.changes ?? 2;
  return {
    applied,
    async plan(target) {
      return {
        digest: "sha256:set",
        empty: changes === 0,
        ...(opts.failPlan ? { failed: true, message: "network: plan failed" } : {}),
        rows: ["network", "app"].map((root) => ({ component: root, status: "planned", create: changes, update: 0, replace: 0, delete: 0, location: `s3://state-test/${root}/terraform-${target.env}.tfstate` })),
      };
    },
    async apply(target, { planned }) {
      applied.push(...planned.rows.map((r) => r.component));
      return {
        status: "applied",
        rows: planned.rows.map((r) => ({ ...r, status: "applied" })),
        locations: Object.fromEntries(planned.rows.map((r) => [r.component, r.location!])),
      };
    },
  };
}

const UP = { pr: 7, head: HEAD, template: "staging", ttl: "72h", stack: "shop", now: () => NOW };

describe("up", () => {
  test("a non-empty plan waits for an approval of its digest and applies nothing", async () => {
    const p = ports();
    const adapter = roots();
    const r = await prEnvUp({ ...UP, adapter, ports: p });
    expect(r.exit).toBe(3);
    expect(r.report.status).toBe("waiting");
    expect(p.asked).toEqual(["pr-7 pr-env sha256:set"]);
    expect(adapter.applied).toEqual([]);
    expect(p.records).toEqual([]);
    expect(renderPrEnvNote(r.report)).toContain("chant approve pr-7 pr-env --plan sha256:set");
  });

  test("an approved plan applies, and the record keeps each root's location for the teardown", async () => {
    const p = ports({ status: "approved", approvedBy: ["reviewer"] });
    const r = await prEnvUp({ ...UP, adapter: roots(), ports: p, actor: "octo" });
    expect(r.exit).toBe(0);
    expect(r.record).toMatchObject({ kind: "up", env: "pr-7", marker: { stack: "shop", env: "pr-7" }, components: ["network", "app"], approvedBy: ["reviewer"], expiresAt: "2026-10-26T10:00:00.000Z", releaseTarget: false });
    expect(livePrEnvironments(p.records).get("pr-7")?.locations).toEqual({ network: "s3://state-test/network/terraform-pr-7.tfstate", app: "s3://state-test/app/terraform-pr-7.tfstate" });
    expect(p.published.map((x) => x.status)).toEqual(["applied"]);
    expect(renderPrEnvNote(r.report)).toContain("s3://state-test/app/terraform-pr-7.tfstate");
  });

  test("an empty plan applies at once, with no approval asked", async () => {
    const p = ports();
    const r = await prEnvUp({ ...UP, adapter: roots({ changes: 0 }), ports: p });
    expect(r.exit).toBe(0);
    expect(p.asked).toEqual([]);
    expect(p.records).toHaveLength(1);
  });

  test("a failed plan applies nothing and keeps no record", async () => {
    const p = ports({ status: "approved" });
    const adapter = roots({ failPlan: true });
    const r = await prEnvUp({ ...UP, adapter, ports: p });
    expect(r.exit).toBe(1);
    expect(r.report.status).toBe("plan-failed");
    expect(adapter.applied).toEqual([]);
    expect(p.records).toEqual([]);
  });

  test("an apply that stopped before anything applied keeps no record", async () => {
    const p = ports({ status: "approved" });
    const adapter: PrEnvAdapter = { ...roots(), apply: async (_t, { planned }) => ({ status: "stopped", rows: planned.rows, message: "the before-apply hook failed" }) };
    const r = await prEnvUp({ ...UP, adapter, ports: p });
    expect(r.exit).toBe(1);
    expect(p.records).toEqual([]);
  });
});

/** A teardown adapter over the roots the record names: each root's copy, with the marker its key's suffix says. */
function destroyer(opts: { foreign?: boolean } = {}): PrEnvTeardownAdapter & { destroyed: string[] } {
  const destroyed: string[] = [];
  return {
    name: "terragucci",
    lexicons: ["terraform"],
    destroyed,
    async owned({ live, marker }) {
      const candidates: TeardownCandidate[] = Object.entries(live.locations ?? {}).map(([root, location]) => ({ name: root, type: "Terraform::Root", physicalId: location, marker: { stack: marker.stack, env: /-(pr-[0-9]+)\.tfstate$/.exec(location)?.[1] ?? "" } }));
      if (opts.foreign) candidates.push({ name: "shared", type: "Terraform::Root", physicalId: "s3://state-test/shared/terraform.tfstate", marker: { stack: "shop", env: "staging" } });
      return { candidates };
    },
    async teardown({ candidates }) {
      destroyed.push(...candidates.map((c) => c.name));
      return { outcomes: candidates.map((c) => ({ name: c.name, outcome: "deleted" as const })) };
    },
  };
}

/** The terraform lexicon as it stands: it reads resources and has no teardown execution. */
const terraformLexicon = {
  name: "terraform",
  async teardownOwned() {
    return { candidates: [{ name: "aws_s3_bucket.assets", type: "aws_s3_bucket", marker: { stack: "shop", env: "pr-7" } }] };
  },
} as unknown as ObservationLexicon;

async function applied(): Promise<PrEnvRecord[]> {
  const p = ports({ status: "approved", approvedBy: ["reviewer"] });
  await prEnvUp({ ...UP, adapter: roots(), ports: p });
  return p.records;
}

describe("down through a product's teardown adapter", () => {
  test("tears down every root's copy, and the terraform lexicon it covers does not leave the environment incomplete", async () => {
    const p = ports(undefined, await applied());
    const d = destroyer();
    const r = await prEnvDown({ pr: 7, reason: "closed", ports: p, plugins: [terraformLexicon], adapters: [d], commit: "c".repeat(40), now: () => NOW });
    expect(r.exit).toBe(0);
    expect(r.report.status).toBe("destroyed");
    expect(d.destroyed.sort()).toEqual(["app", "network"]);
    expect(livePrEnvironments(p.records).has("pr-7")).toBe(false);
  });

  test("a candidate whose marker is another environment's never reaches the adapter's teardown", async () => {
    const p = ports(undefined, await applied());
    const d = destroyer({ foreign: true });
    const r = await prEnvDown({ pr: 7, reason: "closed", ports: p, adapters: [d], commit: "c".repeat(40) });
    expect(d.destroyed).not.toContain("shared");
    expect(r.report.status).toBe("destroyed");
  });

  test("without the adapter, the terraform lexicon's candidates are skipped and the environment stays live", async () => {
    const p = ports(undefined, await applied());
    const r = await prEnvDown({ pr: 7, reason: "closed", ports: p, plugins: [terraformLexicon], commit: "c".repeat(40) });
    expect(r.exit).toBe(1);
    expect(r.report.status).toBe("incomplete");
    expect(livePrEnvironments(p.records).get("pr-7")?.teardownIncomplete).toBe(true);
  });

  test("another pull request's down reads nothing and deletes nothing", async () => {
    const records = await applied();
    const p = ports(undefined, records);
    const d = destroyer();
    const live = livePrEnvironments(records).get("pr-7")!;
    const r = await prEnvDown({ pr: 8, reason: "closed", ports: p, adapters: [d], live, commit: "c".repeat(40) });
    expect(r.report.status).toBe("refused");
    expect(d.destroyed).toEqual([]);
  });
});

describe("sweep", () => {
  test("tears down an expired environment and one whose pull request closed, and keeps an open one", async () => {
    const records = await applied();
    const other = (pr: number, expiresAt: string): PrEnvRecord => ({ ...records[0]!, pr, env: `pr-${pr}`, marker: { stack: "shop", env: `pr-${pr}` }, expiresAt });
    records.push(other(8, "2026-10-30T10:00:00.000Z"), other(9, "2026-10-30T10:00:00.000Z"));
    const p = ports(undefined, records, { 8: "merged", 9: "open" });
    const d = destroyer();
    const r = await prEnvSweep({ ports: p, adapters: [d], commit: "c".repeat(40), now: () => new Date("2026-10-27T10:00:00.000Z") });
    expect(r.results.map((x) => [x.report.env, x.record?.reason])).toEqual([["pr-7", "expired"], ["pr-8", "closed"]]);
    expect([...livePrEnvironments(p.records).keys()]).toEqual(["pr-9"]);
  });
});

describe("a teardown command (ci.prEnvironment.teardown)", () => {
  test("runs the owned and teardown stages without the forge's tokens, and reads their answers as data", async () => {
    const live = livePrEnvironments(await applied()).get("pr-7")!;
    const calls: { argv: string[]; env: Record<string, string> }[] = [];
    const adapter = commandTeardownAdapter(
      { command: ["./teardown.sh", "{stage}", "{env}"], lexicons: ["terraform"] },
      {
        cwd: "/tmp",
        env: { PATH: "/bin", GITHUB_TOKEN: "test-token", CHANT_FORGE_TOKEN: "test-token" },
        exec: (argv, _cwd, env) => {
          calls.push({ argv, env });
          const stage = env[PR_ENV_TEARDOWN_ENV.stage];
          const located = JSON.parse(readFileSync(env[PR_ENV_TEARDOWN_ENV.live]!, "utf-8")) as { locations: Record<string, string> };
          const answer =
            stage === "owned"
              ? { candidates: Object.keys(located.locations).map((root) => ({ name: root, type: "Terraform::Root", marker: { stack: env[PR_ENV_TEARDOWN_ENV.stack], env: env[PR_ENV_TEARDOWN_ENV.env] } })) }
              : { outcomes: (JSON.parse(readFileSync(env[PR_ENV_TEARDOWN_ENV.candidates]!, "utf-8")) as TeardownCandidate[]).map((c) => ({ name: c.name, outcome: "deleted" })) };
          writeFileSync(env[PR_ENV_TEARDOWN_ENV.result]!, JSON.stringify(answer));
          return 0;
        },
      },
    );
    const p = ports(undefined, [{ ...livePrRecord(live) }]);
    const r = await prEnvDown({ pr: 7, reason: "closed", ports: p, plugins: [terraformLexicon], adapters: [adapter], live, commit: "c".repeat(40) });
    expect(r.report.status).toBe("destroyed");
    expect(calls.map((c) => c.argv)).toEqual([["./teardown.sh", "owned", "pr-7"], ["./teardown.sh", "teardown", "pr-7"]]);
    for (const c of calls) {
      expect(c.env.GITHUB_TOKEN).toBeUndefined();
      expect(c.env.CHANT_FORGE_TOKEN).toBeUndefined();
      expect(c.env.PATH).toBe("/bin");
      expect(c.env[PR_ENV_TEARDOWN_ENV.commit]).toBe(HEAD);
    }
  });

  test("a failed owned stage is a hole, so the environment stays live", async () => {
    const live = livePrEnvironments(await applied()).get("pr-7")!;
    const adapter = commandTeardownAdapter({ command: ["false"] }, { cwd: "/tmp", env: {}, exec: () => 2 });
    const r = await prEnvDown({ pr: 7, reason: "closed", ports: ports(), adapters: [adapter], live, commit: "c".repeat(40) });
    expect(r.report.status).toBe("incomplete");
  });

  test("a candidate with no marker read back is refused", () => {
    expect(() => readTeardownEnumeration({ candidates: [{ name: "app", type: "Terraform::Root" }] })).toThrow(/marker/);
  });
});

describe("a component's site in pr-<n>", () => {
  const declared = [
    { name: "staging", runtime: "fly", url: "https://shop-{env}.test.invalid", domain: "staging.test.invalid", lifecycle: "git@test.invalid:shop-staging.git" },
  ];

  test("the template's runtime and lifecycle carry over, a URL naming {env} is filled in, and a literal domain is left out", () => {
    expect(prEnvironmentSite(declared, "staging", "pr-7")).toEqual({ name: "pr-7", runtime: "fly", url: "https://shop-pr-7.test.invalid", lifecycle: "git@test.invalid:shop-staging.git" });
  });

  test("an entry the component declares for the environment itself wins, and no template entry means no site", () => {
    expect(prEnvironmentSite([...declared, { name: "pr-7", url: "https://seven.test.invalid" }], "staging", "pr-7")).toEqual({ name: "pr-7", url: "https://seven.test.invalid" });
    expect(prEnvironmentSite(declared, "prod", "pr-7")).toBeUndefined();
  });
});

function livePrRecord(live: ReturnType<typeof livePrEnvironments> extends Map<string, infer L> ? L : never): PrEnvRecord {
  return { version: 1, kind: "up", pr: live.pr, env: live.env, template: live.template, marker: live.marker, commit: live.commit, components: live.components, ...(live.locations ? { locations: live.locations } : {}), planDigest: "sha256:set", result: "applied", by: "octo", timestamp: live.applied, expiresAt: live.expiresAt, releaseTarget: false };
}
