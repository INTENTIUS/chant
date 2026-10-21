import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Declarable } from "@intentius/chant/declarable";
import { loadChantConfig } from "@intentius/chant/config";
import { armSandboxConfigEvaluation, resetSandboxConfigEvaluationForTests } from "@intentius/chant/config-sandbox";
import { gcpSerializer } from "./serializer";
import { describeResources, manifestProjectAnnotations, resolveReadProject } from "./describe-resources";
import { parseManifest, resolveGcpProject } from "./op/activities/gcp-apply";
import { CloudRunService, PubSubTopic, StorageBucket } from "./generated";
import { defaultAnnotations } from "./default-labels";
import { GCP } from "./pseudo";

/** #4252: one GCP project for build, apply and read, set once in chant.config. */

const ANNOTATION = "cnrm.cloud.google.com/project-id";

function build(entities: Record<string, unknown>, config?: Record<string, unknown>): string {
  const out = gcpSerializer.serialize(new Map(Object.entries(entities)) as Map<string, Declarable>, undefined, config ? { config } : undefined);
  return typeof out === "string" ? out : out.primary;
}

describe("gcp.project in chant.config (#4252)", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    process.env.GCP_PROJECT_ID = "env-id";
    process.env.GOOGLE_CLOUD_PROJECT = "env-google";
  });
  afterEach(() => {
    process.env = saved;
  });

  test("the build writes it as each resource's project-id annotation and resolves GCP.ProjectId from it", () => {
    const yaml = build(
      {
        assets: new StorageBucket({ metadata: { name: "assets" }, location: "US" } as never),
        web: new CloudRunService({ metadata: { name: "web" }, location: "us-central1", projectRef: { external: GCP.ProjectId } } as never),
      },
      { gcp: { project: "cfg-project" } },
    );
    const docs = parseManifest(yaml, "test");
    expect(docs.find((d) => d.metadata?.name === "assets")?.metadata?.annotations?.[ANNOTATION]).toBe("cfg-project");
    expect((docs.find((d) => d.metadata?.name === "web")?.spec as { projectRef: unknown }).projectRef).toEqual({ external: "cfg-project" });
  });

  test("without it the build writes no annotation, as before", () => {
    const yaml = build({ assets: new StorageBucket({ metadata: { name: "assets" }, location: "US" } as never) });
    expect(parseManifest(yaml, "test")[0].metadata?.annotations?.[ANNOTATION]).toBeUndefined();
  });

  test("a defaultAnnotations project wins over the config's", () => {
    const yaml = build(
      {
        assets: new StorageBucket({ metadata: { name: "assets" }, location: "US" } as never),
        annotations: defaultAnnotations({ [ANNOTATION]: "declared-project" }),
      },
      { gcp: { project: "cfg-project" } },
    );
    expect(parseManifest(yaml, "test")[0].metadata?.annotations?.[ANNOTATION]).toBe("declared-project");
  });

  test("apply and read both take it ahead of GCP_PROJECT_ID and GOOGLE_CLOUD_PROJECT, and a projectRef ahead of it", () => {
    const yaml = build(
      {
        assets: new StorageBucket({ metadata: { name: "assets" }, location: "US" } as never),
        other: new StorageBucket({ metadata: { name: "other" }, location: "US", projectRef: { external: "own-project" } } as never),
      },
      { gcp: { project: "cfg-project" } },
    );
    const docs = parseManifest(yaml, "test");
    expect(resolveGcpProject(docs.find((d) => d.metadata?.name === "assets")!)).toBe("cfg-project");
    expect(resolveGcpProject(docs.find((d) => d.metadata?.name === "other")!)).toBe("own-project");

    const manifest = manifestProjectAnnotations(yaml);
    expect(resolveReadProject("StorageBucket", "assets", undefined, manifest, { metadata: { name: "assets" } })).toBe("cfg-project");
    expect(resolveReadProject("StorageBucket", "other", undefined, manifest, { projectRef: { external: "own-project" } })).toBe("own-project");
  });

  test("with nothing declared, read falls back to GCP_PROJECT_ID, then GOOGLE_CLOUD_PROJECT", () => {
    const none = new Map<string, string>();
    expect(resolveReadProject("StorageBucket", "b", undefined, none, {})).toBe("env-id");
    delete process.env.GCP_PROJECT_ID;
    expect(resolveReadProject("StorageBucket", "b", undefined, none, {})).toBe("env-google");
    delete process.env.GOOGLE_CLOUD_PROJECT;
    expect(() => resolveReadProject("StorageBucket", "b", undefined, none, {})).toThrow(/gcp\.project in chant\.config/);
  });
});

describe("gcp.project under --sandbox (#4252)", () => {
  let dir: string;
  beforeEach(async () => {
    const d = join(tmpdir(), `chant-4252-${Date.now()}-${Math.random()}`);
    await mkdir(d, { recursive: true });
    dir = await realpath(d);
    resetSandboxConfigEvaluationForTests();
  });
  afterEach(async () => {
    resetSandboxConfigEvaluationForTests();
    await rm(dir, { recursive: true, force: true });
  });

  test("the config crosses from the sandboxed child as data, and the build reads it from there, not from process.env", async () => {
    await writeFile(join(dir, "chant.config.ts"), `export default { lexicons: ["gcp"], gcp: { project: "sandboxed-project" } };\n`);
    armSandboxConfigEvaluation();
    const { config } = await loadChantConfig(dir);
    expect((config as { gcp?: { project?: string } }).gcp?.project).toBe("sandboxed-project");

    const saved = process.env.GCP_PROJECT_ID;
    delete process.env.GCP_PROJECT_ID;
    try {
      const yaml = build({ assets: new StorageBucket({ metadata: { name: "assets" }, location: "US" } as never) }, config as Record<string, unknown>);
      expect(parseManifest(yaml, "test")[0].metadata?.annotations?.[ANNOTATION]).toBe("sandboxed-project");
    } finally {
      if (saved !== undefined) process.env.GCP_PROJECT_ID = saved;
    }
  });
});

describe("the live read takes gcp.project with no project env var (#4252)", () => {
  let saved: NodeJS.ProcessEnv;
  const fetchMock = vi.fn();
  beforeEach(() => {
    saved = { ...process.env };
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCP_ENDPOINT_URL;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify({ name: "projects/p/topics/assets" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    process.env = saved;
    vi.unstubAllGlobals();
  });

  async function read(config: Record<string, unknown> | undefined, props: Record<string, unknown>) {
    const yaml = build({ assets: new PubSubTopic(props as never) }, config);
    return describeResources({
      environment: "local",
      buildOutput: yaml,
      entityNames: ["assets"],
      entities: new Map([["assets", { entityType: "GCP::Pubsub::Topic", props }]]),
    });
  }

  test("only gcp.project in config: the read targets that project", async () => {
    const result = await read({ gcp: { project: "three-cloud" } }, { metadata: { name: "assets" } });
    expect(result.unobserved?.assets).toBeUndefined();
    expect(result.resources.assets).toBeDefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("three-cloud");
  });

  test("only a project-id annotation on the resource: the read targets that project", async () => {
    const result = await read(undefined, { metadata: { name: "assets", annotations: { [ANNOTATION]: "annotated" } } });
    expect(result.unobserved?.assets).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("annotated");
  });

  test("neither: no-binding, naming every place a project can come from", async () => {
    const result = await read(undefined, { metadata: { name: "assets" } });
    expect(result.unobserved?.assets?.reason).toBe("no-binding");
    expect(result.unobserved?.assets?.detail).toMatch(/gcp\.project in chant\.config/);
  });
});
