/**
 * Consumers joined across a control repo (#4600): two projects' consumers.json
 * give one consumer list per version, each consumer named by its project, and
 * the join feeds the release catalog as its consumers input.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildReleaseCatalog } from "../lifecycle/release-catalog";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import { consumersDocument, joinControlConsumers, parseConsumersDocument, readControlConsumers } from "./consumers";
import type { ControlEntry } from "./records";

const FIX = join(import.meta.dirname, "__fixtures__", "consumers");
const INFRA = "github.com/acme/infra";
const APPS = "gitlab.example.com/acme/apps";
const fixture = (name: string) => readFileSync(join(FIX, name, "consumers.json"), "utf-8");
const projects = () => [
  { project: INFRA, document: fixture("infra") },
  { project: APPS, document: fixture("apps") },
];

const entry = (id: string, project?: string): ControlEntry => ({
  id,
  entry: project ? "project" : "defaults",
  ...(project ? { project } : {}),
  settings: {},
  estates: [],
  digest: `sha256:${id}`,
  at: "2026-10-27T00:00:00.000Z",
});

describe("joinControlConsumers", () => {
  test("gives one consumer list per version across both projects", () => {
    const { consumers, problems } = joinControlConsumers(projects());
    expect(problems).toEqual([]);
    expect(consumers.map((c) => [c.component, c.version ?? c.digest, c.consumers.length])).toEqual([
      ["cache", "sha256:1111111111111111111111111111111111111111111111111111111111111111", 1],
      ["eks", "3.0.0", 1],
      ["vpc", "1.1.0", 1],
      ["vpc", "1.2.0", 4],
    ]);
    const vpc12 = consumers.find((c) => c.component === "vpc" && c.version === "1.2.0")!;
    expect(vpc12.consumers.map((c) => [c.repo, c.root, c.address])).toEqual([
      [INFRA, "live/dev", "module.vpc"],
      [INFRA, "live/prod", "module.vpc"],
      [APPS, "live/prod", "module.vpc"],
      [APPS, "units/network", "terragrunt.terraform"],
    ]);
  });

  test("drops a consumer listed twice and keeps a repo the file names", () => {
    const doc = { contract: 1, consumers: [{ component: "vpc", version: "1.2.0", consumers: [{ root: "a" }, { root: "a" }, { root: "b", repo: "github.com/acme/other" }] }] };
    const { consumers } = joinControlConsumers([{ project: INFRA, document: doc }]);
    expect(consumers[0]!.consumers).toEqual([
      { root: "a", repo: INFRA },
      { root: "b", repo: "github.com/acme/other" },
    ]);
  });

  test("names each problem by its project and keeps what it could read", () => {
    const bad = JSON.stringify({ contract: 1, consumers: [{ component: "vpc", consumers: [] }, { component: "eks", version: "1.0.0", consumers: [{ root: "x" }] }] });
    const { consumers, problems } = joinControlConsumers([
      { project: INFRA, document: bad },
      { project: APPS, document: "{not json" },
    ]);
    expect(consumers.map((c) => c.component)).toEqual(["eks"]);
    expect(problems.some((p) => p.startsWith(`${INFRA}: consumers.json: consumers[0]: names neither`))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${APPS}: consumers.json: not JSON`))).toBe(true);
  });

  test("refuses another contract", () => {
    expect(parseConsumersDocument({ contract: 2, consumers: [] }).problems[0]).toContain("contract 2");
  });

  test("feeds the catalog one consumer list per version", () => {
    const rec = (component: string, releaseVersion: string, digest: string): ReleaseRecord => ({
      version: 1,
      component,
      env: "registry",
      digest,
      gitSha: "1111111111111111111111111111111111111111",
      runId: "run-1",
      timestamp: "2026-10-01T00:00:00.000Z",
      actor: "ci",
      releaseVersion,
    });
    const { consumers } = joinControlConsumers(projects());
    const catalog = buildReleaseCatalog({ releases: [rec("vpc", "1.2.0", "sha256:v12"), rec("vpc", "1.1.0", "sha256:v11")], consumers }, { generatedAt: "2026-10-27T00:00:00.000Z", chant: "0.0.0-test" });
    const vpc = catalog.components.find((c) => c.name === "vpc")!;
    expect(vpc.versions.find((v) => v.version === "1.2.0")!.consumers.map((c) => c.repo)).toEqual([INFRA, INFRA, APPS, APPS]);
    expect(vpc.versions.find((v) => v.version === "1.1.0")!.consumers).toHaveLength(1);
  });
});

describe("readControlConsumers", () => {
  test("reads each project the control repo lists, passes the defaults over, and names the missing", async () => {
    const asked: string[] = [];
    const read = async (project: string) => {
      asked.push(project);
      if (project === INFRA) return fixture("infra");
      if (project === APPS) return fixture("apps");
      return null;
    };
    const got = await readControlConsumers([entry("ctl-001"), entry("ctl-002", INFRA), entry("ctl-003", APPS), entry("ctl-004", "github.com/acme/empty")], read);
    expect(asked).toEqual(["github.com/acme/empty", INFRA, APPS]);
    expect(got.missing).toEqual(["github.com/acme/empty"]);
    expect(got.problems).toEqual([]);
    expect(got.consumers.find((c) => c.component === "vpc" && c.version === "1.2.0")!.consumers).toHaveLength(4);
  });

  test("names a project whose read fails and joins the rest", async () => {
    const got = await readControlConsumers([entry("ctl-002", INFRA), entry("ctl-003", APPS)], async (p) => {
      if (p === APPS) throw new Error("403 from the forge");
      return fixture("infra");
    });
    expect(got.problems).toEqual([`${APPS}: consumers.json could not be read: 403 from the forge`]);
    expect(got.consumers.find((c) => c.version === "1.2.0")!.consumers).toHaveLength(2);
  });
});

describe("consumersDocument", () => {
  test("writes a document the join reads back, the same bytes for the same input", () => {
    const { consumers } = parseConsumersDocument(fixture("infra"));
    const text = consumersDocument(consumers);
    expect(consumersDocument([...consumers].reverse())).toBe(text);
    expect(parseConsumersDocument(text).consumers).toHaveLength(3);
  });
});
