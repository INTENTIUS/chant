/**
 * GCP deep observation (#1087) — the GCP row of the deep-observe contract
 * (#1014), and the managed-fields reuse from the k8s row (#1076).
 *
 * Every case here drives the real reader (`observeResourcesDeepGcp`) with
 * `node:child_process`'s `exec` mocked — the same harness
 * `describe-resources.test.ts` uses for the thin read. No ambient kubectl
 * config is read and no cluster is contacted.
 *
 * The end-to-end acceptance test drives `observeResourcesDeepGcp`'s real
 * output through core's real `diffDeepObservation`, with `gcpPlugin`'s real,
 * exported `deepNormalizationHooks` — the same three pieces
 * `lexicons/k8s/src/deep-observe.test.ts` exercises for the k8s row.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      Promise.resolve(execMock(cmd)).then(
        (out) => cb(null, out),
        (err) => cb(err as Error, { stdout: "", stderr: "" }),
      );
    },
  };
});

const loadChantConfigMock = vi.fn();
vi.mock("@intentius/chant/config", () => ({
  loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args),
}));

const { gcpPlugin } = await import("./plugin");
const { observeResourcesDeepGcp } = await import("./deep-observe");
const { gcpDeepNormalizationHooks } = await import("./deep-observe-hooks");
const { diffDeepObservation, observeDeep } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation, normalizeDeepProperties } = await import("@intentius/chant/deep-observation");

type Entity = { name: string; entityType: string; props: Record<string, unknown> };
function makeEntities(records: Entity[]): Map<string, { entityType: string; props: Record<string, unknown> }> {
  return new Map(records.map((r) => [r.name, { entityType: r.entityType, props: r.props }]));
}

/** Route a mocked `kubectl get <resource> <name> ... -o json` command to a canned JSON body, by matching on `<resource> <name>`. */
function respondTo(bodies: Record<string, unknown>): (cmd: string) => { stdout: string; stderr: string } {
  return (cmd: string) => {
    for (const [needle, body] of Object.entries(bodies)) {
      if (cmd.includes(needle)) return { stdout: JSON.stringify(body), stderr: "" };
    }
    throw new Error(`unexpected kubectl invocation: ${cmd}`);
  };
}

beforeEach(() => {
  execMock.mockReset();
  loadChantConfigMock.mockReset();
  loadChantConfigMock.mockResolvedValue({ config: {} });
});

describe("gcpPlugin wiring (#1087)", () => {
  test("the plugin exposes the deep-observe contract, and the hooks are the shared static instance", () => {
    expect(typeof gcpPlugin.observeResourcesDeep).toBe("function");
    expect(gcpPlugin.deepNormalizationHooks).toBe(gcpDeepNormalizationHooks);
  });
});

describe("gcpDeepNormalizationHooks — the static rules", () => {
  test("prunes status and the server-minted metadata fields, reused verbatim from the k8s row", () => {
    const out = normalizeDeepProperties(
      {
        status: { conditions: [{ type: "Ready", status: "True" }] },
        metadata: {
          name: "data-bucket",
          uid: "u-1",
          resourceVersion: "7",
          generation: 3,
          creationTimestamp: "2026-01-01T00:00:00Z",
          managedFields: [{ manager: "cnrm-controller-manager" }],
          labels: { app: "web" },
        },
      },
      { entityType: "GCP::Storage::Bucket", side: "live", hooks: gcpDeepNormalizationHooks },
    );
    expect(out).toEqual({ metadata: { name: "data-bucket", labels: { app: "web" } } });
  });

  test("prunes Config Connector's own observed-state annotation, but not a user-authored cnrm.cloud.google.com annotation", () => {
    const out = normalizeDeepProperties(
      {
        metadata: {
          annotations: {
            "cnrm.cloud.google.com/observed-secret-versions": '{"db-password":"1"}',
            "cnrm.cloud.google.com/deletion-policy": "abandon",
          },
        },
      },
      { entityType: "GCP::Storage::Bucket", side: "live", hooks: gcpDeepNormalizationHooks },
    );
    expect(out).toEqual({ metadata: { annotations: { "cnrm.cloud.google.com/deletion-policy": "abandon" } } });
  });

  test("orders containers by name — reused for CNRM kinds embedding a k8s-shaped pod spec (e.g. Cloud Run's RunService)", () => {
    const out = normalizeDeepProperties(
      { spec: { template: { spec: { containers: [{ name: "sidecar" }, { name: "app" }] } } } },
      { entityType: "GCP::Run::Service", side: "live", hooks: gcpDeepNormalizationHooks },
    );
    expect(
      (out.spec as { template: { spec: { containers: Array<{ name: string }> } } }).template.spec.containers.map((c) => c.name),
    ).toEqual(["app", "sidecar"]);
  });
});

describe("observeResourcesDeepGcp — reading through kubectl (#1087)", () => {
  test("a hand-edited field surfaces with its path; an unsupported entity type is unsupported-kind", async () => {
    execMock.mockImplementation(
      respondTo({
        "storagebucket.storage.cnrm.cloud.google.com data-bucket": {
          apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
          kind: "StorageBucket",
          metadata: {
            name: "data-bucket",
            namespace: "config-control",
            uid: "uid-bucket",
            labels: { app: "web-renamed" },
            managedFields: [
              {
                manager: "kubectl-edit",
                operation: "Update",
                fieldsV1: { "f:metadata": { "f:labels": { "f:app": {} } } },
              },
            ],
          },
          spec: {},
          status: {},
        },
      }),
    );

    const result = normalizeDeepObservation(
      await observeResourcesDeepGcp({
        environment: "prod",
        entityNames: ["dataBucket", "unknownKind"],
        entities: makeEntities([
          {
            name: "dataBucket",
            entityType: "GCP::Storage::Bucket",
            props: { metadata: { name: "data-bucket", namespace: "config-control", labels: { app: "web" } } },
          },
          { name: "unknownKind", entityType: "AWS::S3::Bucket", props: { metadata: { name: "x" } } },
        ]),
      }),
    );

    expect(result.resources.dataBucket.properties).toMatchObject({ metadata: { labels: { app: "web-renamed" } } });
    expect(result.resources.dataBucket.properties).not.toHaveProperty("status");
    expect(result.unobserved.unknownKind.reason).toBe("unsupported-kind");
  });

  test("a read failure is a hole with a reason, never silence", async () => {
    execMock.mockImplementation(() => {
      throw Object.assign(new Error("kubectl failed"), { stderr: "Error from server (Forbidden): storagebuckets.storage.cnrm.cloud.google.com is forbidden" });
    });
    const result = normalizeDeepObservation(
      await observeResourcesDeepGcp({
        environment: "prod",
        entityNames: ["broken"],
        entities: makeEntities([
          { name: "broken", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "broken" } } },
        ]),
      }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.broken.reason).toBe("no-credentials");
  });

  test("--owned withholds an unmarked object as filtered, not absent", async () => {
    execMock.mockImplementation(
      respondTo({
        "storagebucket.storage.cnrm.cloud.google.com theirs": {
          apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
          kind: "StorageBucket",
          metadata: { name: "theirs", uid: "uid-theirs" },
          spec: {},
        },
      }),
    );
    const result = normalizeDeepObservation(
      await observeResourcesDeepGcp({
        environment: "prod",
        entityNames: ["theirs"],
        owned: true,
        entities: makeEntities([{ name: "theirs", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "theirs" } } }]),
      }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.theirs.reason).toBe("filtered");
  });
});

/**
 * The acceptance test for #1087, in the reference shape
 * (`lexicons/aws/src/deep-observe.test.ts` / `lexicons/k8s/src/deep-observe.test.ts`):
 * declared source, a live tree carrying realistic Config Connector
 * managedFields noise, driven through the real reader and core's real
 * `diffDeepObservation`, with `gcpPlugin`'s real static hooks.
 */
describe("end to end: Config Connector managed-fields-derived drift (#1087)", () => {
  const declared = makeEntities([
    // "dataBucket": chant's own kubectl-apply owns most fields (attributed to
    // "kubectl-client-side-apply", not "chant" — see the module doc's GCP
    // twist); CNRM owns an undeclared field and an observed-state annotation
    // (both pruned); a hand kubectl-edit changed a declared label (drift);
    // a declared annotation moved to a value the baseline accepts.
    {
      name: "dataBucket",
      entityType: "GCP::Storage::Bucket",
      props: {
        metadata: {
          name: "data-bucket",
          namespace: "config-control",
          labels: { app: "web", "cnrm-test": "true" },
          annotations: { "build-id": "42" },
        },
        spec: { location: "US", storageClass: "STANDARD" },
      },
    },
    // "sqlInstance": chant declares spec.tier; Config Connector's OWN
    // controller currently holds it at a different value (a manual gcloud
    // change the controller's "merge" reconciliation folded back in). Foreign
    // ownership does not silence it, because chant declared it too —
    // contested, same as k8s's "worker" case, but contested by CNRM itself
    // rather than by a human.
    {
      name: "sqlInstance",
      entityType: "GCP::SQL::Instance",
      props: {
        metadata: { name: "primary-db", namespace: "config-control" },
        spec: { tier: "db-f1-micro" },
      },
    },
    // No Config Connector GVK derivable for this type at all.
    { name: "cache", entityType: "AWS::ElastiCache::CacheCluster", props: { metadata: { name: "cache" } } },
    // The read itself fails.
    { name: "broken", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "broken" } } },
  ]);

  const bucketLive = {
    apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
    kind: "StorageBucket",
    metadata: {
      name: "data-bucket",
      namespace: "config-control",
      uid: "uid-bucket",
      resourceVersion: "42",
      generation: 7,
      creationTimestamp: "2026-01-01T00:00:00Z",
      // GENUINE DRIFT: chant declares this label; a person ran `kubectl edit`
      // and it now belongs to "kubectl-edit", not chant's own apply.
      labels: { app: "web-renamed", "cnrm-test": "true" },
      // ACCEPTED: chant declares this annotation; the platform's baseline
      // accepts "43".
      annotations: {
        "build-id": "43",
        // NOISE: CNRM's own observed-state bookkeeping, undeclared.
        "cnrm.cloud.google.com/observed-secret-versions": '{"db-password":"1"}',
        // NOISE: classic `kubectl apply`'s own bookkeeping, undeclared —
        // pruned by the reused ownership rule with no special case needed,
        // because its manager ("kubectl-client-side-apply") is foreign and
        // chant's declared tree never carries this key.
        "kubectl.kubernetes.io/last-applied-configuration": "{...}",
      },
      managedFields: [
        {
          manager: "kubectl-client-side-apply",
          operation: "Update",
          fieldsV1: {
            "f:metadata": {
              "f:labels": { "f:cnrm-test": {} },
              "f:annotations": {
                "f:build-id": {},
                "f:kubectl.kubernetes.io/last-applied-configuration": {},
              },
            },
            "f:spec": { "f:location": {}, "f:storageClass": {} },
          },
        },
        {
          // The hand edit — transferred ownership of just this one label.
          manager: "kubectl-edit",
          operation: "Update",
          fieldsV1: { "f:metadata": { "f:labels": { "f:app": {} } } },
        },
        {
          // NOISE: Config Connector's own controller sets an undeclared
          // field and its own bookkeeping annotation.
          manager: "cnrm-controller-manager",
          operation: "Update",
          fieldsV1: {
            "f:spec": { "f:uniformBucketLevelAccess": {} },
            "f:metadata": { "f:annotations": { "f:cnrm.cloud.google.com/observed-secret-versions": {} } },
          },
        },
        {
          // NOISE: status is a subresource write, excluded by default.
          manager: "cnrm-controller-manager",
          operation: "Update",
          subresource: "status",
          fieldsV1: { "f:status": { "f:conditions": {} } },
        },
      ],
    },
    spec: { location: "US", storageClass: "STANDARD", uniformBucketLevelAccess: true },
    status: { conditions: [{ type: "Ready", status: "True" }] },
  };

  const sqlInstanceLive = {
    apiVersion: "sql.cnrm.cloud.google.com/v1beta1",
    kind: "SQLInstance",
    metadata: {
      name: "primary-db",
      namespace: "config-control",
      uid: "uid-sql",
      managedFields: [
        {
          // Config Connector's own reconciliation currently holds `spec.tier`
          // — contested because chant declares it too, regardless of who's
          // holding it live.
          manager: "cnrm-controller-manager",
          operation: "Update",
          fieldsV1: { "f:spec": { "f:tier": {} } },
        },
      ],
    },
    spec: { tier: "db-n1-standard-1" },
  };

  const cluster = () =>
    respondTo({
      "storagebucket.storage.cnrm.cloud.google.com data-bucket": bucketLive,
      "sqlinstance.sql.cnrm.cloud.google.com primary-db": sqlInstanceLive,
    });

  const baseline = {
    dataBucket: {
      type: "GCP::Storage::Bucket",
      accepted: [{ path: "metadata.annotations.build-id", value: "43" }],
    },
  };

  test("exactly the genuine + contested drift surfaces; controller/kubectl-apply noise and the accepted annotation do not", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("broken")) throw Object.assign(new Error("boom"), { stderr: "Error from server (InternalError): backend unavailable" });
      return cluster()(cmd);
    });

    const live = normalizeDeepObservation(
      await observeResourcesDeepGcp({ environment: "prod", entityNames: [...declared.keys()], entities: declared }),
    );
    const result = diffDeepObservation(declared, live, gcpDeepNormalizationHooks, baseline);

    expect(result.drifted).toEqual([
      {
        name: "dataBucket",
        type: "GCP::Storage::Bucket",
        changes: [{ path: "metadata.labels.app", kind: "changed", declared: "web", live: "web-renamed" }],
      },
      {
        name: "sqlInstance",
        type: "GCP::SQL::Instance",
        changes: [{ path: "spec.tier", kind: "changed", declared: "db-f1-micro", live: "db-n1-standard-1" }],
      },
    ]);

    expect(result.accepted).toEqual([
      {
        name: "dataBucket",
        type: "GCP::Storage::Bucket",
        changes: [{ path: "metadata.annotations.build-id", kind: "changed", declared: "42", live: "43", baseline: "43" }],
      },
    ]);

    // CNRM's undeclared field, its observed-state annotation, and classic
    // kubectl's own bookkeeping annotation never appear at all — not as
    // drift, not as "undeclared" noise.
    const bucketDriftPaths = result.drifted.find((d) => d.name === "dataBucket")?.changes.map((c) => c.path) ?? [];
    expect(bucketDriftPaths).not.toContain("spec.uniformBucketLevelAccess");
    expect(JSON.stringify(result)).not.toContain("observed-secret-versions");
    expect(JSON.stringify(result)).not.toContain("last-applied-configuration");

    expect(result.unobserved).toEqual([
      { name: "broken", type: "GCP::Storage::Bucket", reason: "read-failed", detail: expect.stringContaining("InternalError") },
      {
        name: "cache",
        type: "AWS::ElastiCache::CacheCluster",
        reason: "unsupported-kind",
        detail: expect.stringContaining("cannot derive a Config Connector GVK"),
      },
    ]);
  });

  test("without the baseline the annotation is drift too; accepting it is what silences it", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("broken")) throw Object.assign(new Error("boom"), { stderr: "Error from server (InternalError): backend unavailable" });
      return cluster()(cmd);
    });
    const live = normalizeDeepObservation(
      await observeResourcesDeepGcp({ environment: "prod", entityNames: [...declared.keys()], entities: declared }),
    );
    const result = diffDeepObservation(declared, live, gcpDeepNormalizationHooks);
    const bucket = result.drifted.find((d) => d.name === "dataBucket");
    expect(bucket?.changes.map((c) => c.path).sort()).toEqual(["metadata.annotations.build-id", "metadata.labels.app"]);
    expect(result.accepted).toEqual([]);
  });

  test("a whole-lexicon failure (bound-context mismatch) is a hole for every declared entity, never a clean report", async () => {
    loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-cnrm" } } } } });
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("current-context")) return { stdout: "staging-cnrm\n", stderr: "" };
      throw new Error(`unexpected cmd (should have refused before any kubectl get): ${cmd}`);
    });

    const live = await observeDeep(gcpPlugin, { environment: "prod", buildOutput: "", entities: declared });
    expect(live.resources).toEqual({});
    expect(new Set(Object.values(live.unobserved).map((u) => u.reason))).toEqual(new Set(["read-failed"]));
    expect(Object.keys(live.unobserved).sort()).toEqual(["broken", "cache", "dataBucket", "sqlInstance"]);
  });
});

/**
 * The managers-specific case: on GCP's real kubectl-shelled apply path,
 * chant's own writes are attributed to kubectl's own default manager
 * (`kubectl-client-side-apply`), never to `chant`/`chant:<stack>` — unlike
 * the k8s lexicon's typed-client SSA path. This proves the contested-field
 * rule (question 3: "is it declared?") is what keeps GCP's drift semantics
 * correct despite that, exactly as the module doc claims: the same live
 * mutation is drift when declared and silence when undeclared, regardless of
 * which non-chant manager holds the field.
 */
describe("the GCP manager twist: no chant-branded field manager, and the contested rule covers it anyway (#1087)", () => {
  const liveWith = (manager: string, imageTag: string) => ({
    apiVersion: "run.cnrm.cloud.google.com/v1beta1",
    kind: "RunService",
    metadata: {
      name: "app",
      namespace: "config-control",
      uid: "uid-app",
      managedFields: [
        { manager, operation: "Update", fieldsV1: { "f:spec": { "f:template": { "f:spec": { "f:containers": { 'k:{"name":"app"}': { "f:image": {} } } } } } } },
      ],
    },
    spec: { template: { spec: { containers: [{ name: "app", image: imageTag }] } } },
  });

  const declaredWith = (declareImage: boolean) =>
    makeEntities([
      {
        name: "app",
        entityType: "GCP::Run::Service",
        props: {
          metadata: { name: "app", namespace: "config-control" },
          spec: { template: { spec: { containers: declareImage ? [{ name: "app", image: "app:1.0" }] : [{ name: "app" }] } } },
        },
      },
    ]);

  test("declared: the same mutated value is drift, whether the owning manager is kubectl's default or CNRM's controller", async () => {
    for (const manager of ["kubectl-client-side-apply", "cnrm-controller-manager", "some-other-operator"]) {
      execMock.mockImplementation(respondTo({ "runservice.run.cnrm.cloud.google.com app": liveWith(manager, "app:2.0") }));
      const entities = declaredWith(true);
      const live = normalizeDeepObservation(
        await observeResourcesDeepGcp({ environment: "prod", entityNames: ["app"], entities }),
      );
      const result = diffDeepObservation(entities, live, gcpDeepNormalizationHooks);
      expect(result.drifted, `manager ${manager}`).toEqual([
        {
          name: "app",
          type: "GCP::Run::Service",
          changes: [{ path: "spec.template.spec.containers[#app].image", kind: "changed", declared: "app:1.0", live: "app:2.0" }],
        },
      ]);
    }
  });

  test("undeclared: the same mutated value is silence, not drift and not undeclared noise, whoever the manager is", async () => {
    for (const manager of ["kubectl-client-side-apply", "cnrm-controller-manager", "some-other-operator"]) {
      execMock.mockImplementation(respondTo({ "runservice.run.cnrm.cloud.google.com app": liveWith(manager, "app:2.0") }));
      const entities = declaredWith(false);
      const live = normalizeDeepObservation(
        await observeResourcesDeepGcp({ environment: "prod", entityNames: ["app"], entities }),
      );
      const result = diffDeepObservation(entities, live, gcpDeepNormalizationHooks);
      expect(result.drifted, `manager ${manager}`).toEqual([]);
      expect(result.unchanged, `manager ${manager}`).toEqual(["app"]);
      expect(JSON.stringify(result)).not.toContain("app:2.0");
    }
  });

  test("chant's own field-manager naming scheme, if it were ever used on this path, would also be recognized", async () => {
    // Future-proofing check: an explicit `chant`/`chant:<stack>` manager (were
    // gcp's apply path ever to route through server-side apply, matching the
    // k8s lexicon) is still classified chant-owned, not merely contested.
    execMock.mockImplementation(respondTo({ "runservice.run.cnrm.cloud.google.com app": liveWith("chant:crdb-gke", "app:2.0") }));
    const entities = declaredWith(false); // undeclared — the only way to tell "chant-owned" apart from "contested" behaviorally.
    const live = normalizeDeepObservation(
      await observeResourcesDeepGcp({ environment: "prod", entityNames: ["app"], entities }),
    );
    const result = diffDeepObservation(entities, live, gcpDeepNormalizationHooks);
    // Chant-owned paths are never pruned by the ownership rule, even when
    // undeclared — so this reports as an undeclared live property, not silence.
    expect(result.drifted).toEqual([
      {
        name: "app",
        type: "GCP::Run::Service",
        changes: [{ path: "spec.template.spec.containers[#app].image", kind: "undeclared", live: "app:2.0" }],
      },
    ]);
  });
});
