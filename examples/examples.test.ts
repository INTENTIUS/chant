import { describe, test, expect, vi } from "vitest";
// The fly-deploy-rollback Ops gate their Emulators/Verify/teardown phases on the
// emulator base-URL env vars (present offline, unset in real mode). Set them
// before the Op modules load — via vi.hoisted, which runs above the imports —
// so the shape assertions below see the full offline phase list. `??=` leaves a
// real run's own values untouched.
vi.hoisted(() => {
  process.env.FLY_FLAPS_BASE_URL ??= "http://localhost:4280";
  process.env.SPRITES_BASE_URL ??= "http://localhost:4290";
});
import { describeExample } from "@intentius/chant-test-utils/example-harness";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { awsSerializer } from "@intentius/chant-lexicon-aws";
import { gcpSerializer } from "@intentius/chant-lexicon-gcp";
import { azureSerializer } from "@intentius/chant-lexicon-azure";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import { gitlabSerializer } from "@intentius/chant-lexicon-gitlab";
import { helmSerializer } from "@intentius/chant-lexicon-helm";
import { flySerializer } from "@intentius/chant-lexicon-fly";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { k8sPlugin } from "@intentius/chant-lexicon-k8s/plugin";
import deployOp from "./getting-started/deploy.op";
import flyDeployOp from "./local-fly/ops/fly.op";
import flyReconcileOp from "./fly-reconcile/ops/fly.op";
import agentTaskOp from "./sprites-agent-task/ops/agent-task.op";
import guardedTaskOp from "./sprites-agent-task/ops/guarded-task.op";
import managedAgentSessionOp from "./sprites-managed-agent-worker/ops/managed-agent-session.op";
import buildSandboxOp from "./sprites-build-sandbox/ops/build-sandbox.op";
import flyDurableDeployOp from "./fly-durable-deploy/ops/fly-durable-deploy.op";
import flyRollbackOp from "./fly-deploy-rollback/ops/fly-deploy.op";
import flyRollbackGuardedOp from "./fly-deploy-rollback/ops/fly-deploy-guarded.op";
import deployGatedOp from "./getting-started/deploy-gated.op";
import observeOp from "./getting-started/observe.op";
import reconcileOp from "./getting-started/reconcile.op";
import applyOp from "./getting-started/apply.op";
import { resolve } from "path";

/** Read an Op default export's name. */
function opName(op: unknown): string {
  return (op as { props: { name: string } }).props.name;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Parse multi-doc YAML into an array of { kind, name, doc } objects. */
function parseK8sDocs(yaml: string) {
  return yaml
    .split("---")
    .filter((d) => d.trim())
    .map((doc) => {
      const kind = doc.match(/kind:\s+(\S+)/)?.[1] ?? "";
      const name = doc.match(/\s+name:\s+(\S+)/)?.[1] ?? "";
      return { kind, name, doc };
    });
}

// ── CC lane canonical AWS estate (epic #1198) ────────────────────────
// VPC/subnet/EC2/SG across two source directories, one component owning all
// ten resources. Deployed to Floci by behold's `just e2e-aws-logical`
// (behold#100) and by #1208's round-trip; the assertions here are the offline
// half — it synthesizes and lints like any other example.

describeExample("cc-aws-canonical", {
  lexicon: "aws+k8s",
  serializer: [awsSerializer, k8sSerializer],
  outputKey: ["aws", "k8s"],
  examplesDir: import.meta.dirname,
});

// ── CC lane canonical Azure estate (epic #1200) ──────────────────────
// VnetDefault networking + an AKS managedCluster + the k8s Service on it.
// Deployed to floci-az by #1214's round-trip (`just azure-cc-e2e`); the
// assertions here are the offline half — it synthesizes and lints like any
// other example.

describeExample("cc-azure-canonical", {
  lexicon: "azure+k8s",
  serializer: [azureSerializer, k8sSerializer],
  outputKey: ["azure", "k8s"],
  examplesDir: import.meta.dirname,
});

// ── CC lane canonical GCP estate (epic #1199) ────────────────────────
// Every kind the direct-REST applier can write (gcpApply's MAPPERS): bucket,
// topic + subscription, secret, service account, Cloud Run service. Deployed
// to floci-gcp by `just gcp-cc-e2e` (#1211); the assertions here are the
// offline half — it synthesizes and lints like any other example.

describeExample("cc-gcp-canonical", {
  lexicon: "gcp",
  serializer: gcpSerializer,
  outputKey: "gcp",
  examplesDir: import.meta.dirname,
});

// ── GitLab + AWS ALB examples ────────────────────────────────────────

describeExample("gitlab-aws-alb-infra", {
  lexicon: "gitlab-aws-alb",
  serializer: [awsSerializer, gitlabSerializer],
  outputKey: ["aws", "gitlab"],
  examplesDir: import.meta.dirname,
});

describeExample("gitlab-aws-alb-api", {
  lexicon: "gitlab-aws-alb",
  serializer: [awsSerializer, gitlabSerializer],
  outputKey: ["aws", "gitlab"],
  examplesDir: import.meta.dirname,
});

describeExample("gitlab-aws-alb-ui", {
  lexicon: "gitlab-aws-alb",
  serializer: [awsSerializer, gitlabSerializer],
  outputKey: ["aws", "gitlab"],
  examplesDir: import.meta.dirname,
});

// ── Bedrock AgentCore agent — composite/base path (#882) ─────────────
// AgentCoreAgent wires Runtime + RuntimeEndpoint + Memory + Gateway/
// GatewayTarget + WorkloadIdentity + IAM into one CloudFormation stack,
// deployed by agent.component.ts with cfn-deploy + wait-for-stack (no
// bespoke verb). The agentcore-deploy version-promotion capability is
// deferred — see the example's README.

describeExample(
  "bedrock-agentcore-agent",
  {
    lexicon: "aws",
    serializer: [awsSerializer],
    outputKey: "aws",
    examplesDir: import.meta.dirname,
  },
  {
    checks: (output) => {
      const template = JSON.parse(output);
      expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");

      expect(template.Resources.agentRuntime.Type).toBe("AWS::BedrockAgentCore::Runtime");
      expect(template.Resources.agentEndpoint.Type).toBe("AWS::BedrockAgentCore::RuntimeEndpoint");
      expect(template.Resources.agentMemory.Type).toBe("AWS::BedrockAgentCore::Memory");
      expect(template.Resources.agentGateway.Type).toBe("AWS::BedrockAgentCore::Gateway");
      expect(template.Resources.agentGatewayTarget.Type).toBe("AWS::BedrockAgentCore::GatewayTarget");
      expect(template.Resources.agentWorkloadIdentity.Type).toBe("AWS::BedrockAgentCore::WorkloadIdentity");
      expect(template.Resources.agentRole.Type).toBe("AWS::IAM::Role");
      expect(template.Resources.agentGatewayRole.Type).toBe("AWS::IAM::Role");

      // Cross-references resolved to CFN intrinsics, no live objects left over.
      expect(template.Resources.agentRuntime.Properties.RoleArn).toEqual({
        "Fn::GetAtt": ["agentRole", "Arn"],
      });
      expect(template.Resources.agentEndpoint.Properties.AgentRuntimeId).toEqual({
        "Fn::GetAtt": ["agentRuntime", "AgentRuntimeId"],
      });

      // The kebab-case example name is sanitized for the Runtime family's
      // no-hyphen CFN pattern (^[a-zA-Z][a-zA-Z0-9_]{0,47}$).
      expect(template.Resources.agentRuntime.Properties.AgentRuntimeName).toBe("support_agent");

      expect(template.Outputs.RuntimeArn).toBeDefined();
      expect(template.Outputs.EndpointArn).toBeDefined();
      expect(template.Outputs.GatewayUrl).toBeDefined();
    },
  },
);

// ── Golden teaching example — L1 (synthesis core) ────────────────────

describeExample(
  "getting-started",
  {
    lexicon: "k8s",
    serializer: k8sSerializer,
    outputKey: "k8s",
    examplesDir: import.meta.dirname,
  },
  {
    checks: (output) => {
      const docs = parseK8sDocs(output);
      const kinds = docs.map((d) => d.kind);
      expect(kinds).toContain("Deployment");
      expect(kinds).toContain("Service");
      expect(kinds).toContain("PodDisruptionBudget");
      for (const doc of docs) {
        expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
      }
    },
  },
);

// ── Golden teaching example — L2 (deploy Op) ─────────────────────────
// The deploy Op can't run in CI (no cluster), so this validates that it
// compiles to a well-formed Op. Running it is a documented local step
// (k3d + `chant run deploy`).

describe("golden example L2 — deploy Op", () => {
  test("compiles to a well-formed Op", () => {
    const props = (deployOp as unknown as {
      props: { name: string; phases: Array<{ name: string }> };
    }).props;
    expect(props.name).toBe("deploy");
    expect(props.phases.map((p) => p.name)).toEqual(["Build", "Apply"]);
  });
});

// ── Golden teaching example — L3 (gate + Temporal) ───────────────────
// Gated deploy Op — runs on Temporal (--temporal), not the local executor.
// Validated by compilation; the gated run is a documented local step.

describe("golden example L3 — gated deploy Op", () => {
  test("compiles with an approval gate and rollback", () => {
    const props = (deployGatedOp as unknown as {
      props: {
        name: string;
        phases: Array<{ name: string; steps: Array<{ kind: string }> }>;
        onFailure?: Array<{ name: string }>;
      };
    }).props;
    expect(props.name).toBe("deploy-gated");
    expect(props.phases.map((p) => p.name)).toEqual(["Build", "Approve", "Apply"]);
    const approve = props.phases.find((p) => p.name === "Approve");
    expect(approve?.steps.some((s) => s.kind === "gate")).toBe(true);
    expect(props.onFailure?.map((p) => p.name)).toEqual(["Rollback"]);
  });
});

// ── Golden teaching example — L4 (the lifecycle dial) ────────────────
// observe → reconcile → authoritative, as three composite-generated Ops.
// Validated by compilation; running them needs a cluster (local step).

describe("golden example L4 — lifecycle dial", () => {
  test("observe / reconcile / apply Ops all compile", () => {
    expect(opName(observeOp)).toBe("observe");
    expect(opName(reconcileOp)).toBe("reconcile");
    expect(opName(applyOp)).toBe("apply");
  });
});

// ── Golden teaching example — L5 capstone: alert-triage (#74) ────────
// This block validates the app's chant-synthesized k8s manifests. The triage
// workflow itself is raw Temporal (custom agent activities); its workflow,
// worker, and activities have their own CI coverage under
// examples/alert-triage/: a time-skipping workflow test (activities/
// workflow.test.ts — gate behaviour), activity unit tests (activities/
// triage.test.ts), and the event→Alert mappers (app/parse.test.ts).

describeExample(
  "alert-triage",
  {
    lexicon: "k8s",
    serializer: k8sSerializer,
    outputKey: "k8s",
    examplesDir: import.meta.dirname,
  },
  {
    checks: (output) => {
      const docs = parseK8sDocs(output);
      const kinds = docs.map((d) => d.kind);
      // webhook (WebApp) + worker (WorkerPool)
      expect(kinds.filter((k) => k === "Deployment")).toHaveLength(2);
      expect(kinds).toContain("Service");
      expect(kinds).toContain("Ingress");
      // No dangling ServiceAccount reference: every serviceAccountName a pod
      // sets must have a matching ServiceAccount doc (regression guard, #236).
      const saNames = new Set(
        docs.filter((d) => d.kind === "ServiceAccount").map((d) => d.name),
      );
      for (const m of output.matchAll(/serviceAccountName:\s*(\S+)/g)) {
        expect(saNames.has(m[1])).toBe(true);
      }
    },
  },
);

// ── Fly deploy — local-fly (#744) ────────────────────────────────────
// Build-validated in CI (the deploy Op boots mudflaps in Docker, which CI can't
// run). The serializer build asserts the flaps create bodies; a separate block
// compile-validates the Op, mirroring the getting-started deploy Op above.

describeExample(
  "local-fly",
  {
    lexicon: "fly",
    serializer: [flySerializer],
    outputKey: "fly",
    examplesDir: import.meta.dirname,
  },
  {
    checks: (output) => {
      const plan = JSON.parse(output) as Record<
        string,
        { endpoint: string; method: string; body: Record<string, any> }
      >;
      const reqs = Object.values(plan);
      // App create body: POST /v1/apps { app_name, org_slug }. org_slug is
      // required by the Machines API (real Fly and mudflaps >=0.3.1 reject app
      // creation without it); Fly.OrgSlug resolves to "personal" offline.
      const app = reqs.find((r) => r.endpoint === "/v1/apps");
      expect(app).toBeDefined();
      expect(app!.body.app_name).toBe("local-fly-demo");
      expect(app!.body.org_slug).toBe("personal");
      // Machine create body under the app, with a config and the stamped marker.
      const machine = reqs.find((r) => /\/v1\/apps\/[^/]+\/machines$/.test(r.endpoint));
      expect(machine).toBeDefined();
      expect(machine!.endpoint).toBe("/v1/apps/local-fly-demo/machines");
      expect(machine!.body.config).toBeDefined();
      expect(machine!.body.config.image).toBe("flyio/hellofly:latest");
      expect(machine!.body.config.metadata["managed-by"]).toBe("chant");
    },
  },
);

describe("local-fly deploy Op (#744)", () => {
  test("compiles to a well-formed Op with the deploy phases", () => {
    const props = (flyDeployOp as unknown as {
      props: { name: string; phases: Array<{ name: string }> };
    }).props;
    expect(props.name).toBe("fly");
    expect(props.phases.map((p) => p.name)).toEqual([
      "Emulator",
      "Build",
      "Apply",
      "Verify",
      "Teardown",
    ]);
  });
});

// ── Fly reconcile — fly-reconcile (#868) ─────────────────────────────
// A multi-machine stack whose op reconciles against a *running* mudflaps (no
// boot/teardown), so re-runs show create → no-op → update → owned-only prune.
// Build-validated here (the live reconcile is documented in the tutorial); a
// separate block compile-validates the Build → Apply op.

describeExample(
  "fly-reconcile",
  {
    lexicon: "fly",
    serializer: [flySerializer],
    outputKey: "fly",
    examplesDir: import.meta.dirname,
  },
  {
    checks: (output) => {
      const plan = JSON.parse(output) as Record<
        string,
        { endpoint: string; method: string; body: Record<string, any> }
      >;
      const reqs = Object.values(plan);
      const app = reqs.find((r) => r.endpoint === "/v1/apps");
      expect(app!.body.app_name).toBe("fly-reconcile-demo");
      // A volume, created before the machine that mounts it.
      const volume = reqs.find((r) => /\/v1\/apps\/[^/]+\/volumes$/.test(r.endpoint));
      expect(volume!.body.name).toBe("data");
      // Two machines, each carrying the managed-by marker the prune reads back.
      const machines = reqs.filter((r) => /\/v1\/apps\/[^/]+\/machines$/.test(r.endpoint));
      expect(machines.map((m) => m.body.name).sort()).toEqual(["web", "worker"]);
      for (const m of machines) expect(m.body.config.metadata["managed-by"]).toBe("chant");
      // web mounts the volume by name.
      const web = machines.find((m) => m.body.name === "web");
      expect(web!.body.config.mounts).toEqual([{ volume: "data", path: "/data" }]);
    },
  },
);

describe("fly-reconcile op (#868)", () => {
  test("compiles to a Build → Apply reconcile with prune on", () => {
    const props = (flyReconcileOp as unknown as {
      props: { name: string; phases: Array<{ name: string; steps: Array<{ fn: string; args?: Record<string, any> }> }> };
    }).props;
    expect(props.name).toBe("fly-reconcile");
    expect(props.phases.map((p) => p.name)).toEqual(["Build", "Apply"]);
    const apply = props.phases.find((p) => p.name === "Apply")!.steps[0];
    expect(apply.fn).toBe("flyApply");
    expect(apply.args?.prune).toBe(true);
  });
});

// ── Sprites agent task — sprites-agent-task (#762) ───────────────────
// Pure activity-sequence Ops (no build, no serialized plan). The live run is
// documented in the example README (against the in-process fake or real
// Sprites); CI compile/shape-validates both Ops, mirroring the deploy Op blocks
// above. The activities + fake have their own unit/integration coverage under
// lexicons/fly/src/op/activities/sprites{,.integration}.test.ts and
// sprite-fs.test.ts.

describe("sprites-agent-task Ops (#762)", () => {
  test("agent-task compiles to the happy-path phase sequence", () => {
    const props = (agentTaskOp as unknown as {
      props: { name: string; taskQueue?: string; phases: Array<{ name: string; steps: Array<{ fn: string }> }> };
    }).props;
    expect(props.name).toBe("agent-task");
    expect(props.taskQueue).toBe("sprites");
    expect(props.phases.map((p) => p.name)).toEqual([
      "Create",
      "Checkpoint",
      "Stage",
      "Run",
      "Collect",
      "Destroy",
    ]);
    // Each phase step resolves to a sprite activity by name. Stage/Collect use
    // the filesystem activities rather than shelling file I/O through exec.
    expect(props.phases[0].steps[0].fn).toBe("spriteCreate");
    expect(props.phases[2].steps[0].fn).toBe("spriteWriteFile");
    expect(props.phases[4].steps[0].fn).toBe("spriteReadFile");
    expect(props.phases[5].steps[0].fn).toBe("spriteDestroy");
  });

  test("guarded-task compiles with an onFailure Restore (checkpoint-as-compensation)", () => {
    const props = (guardedTaskOp as unknown as {
      props: {
        name: string;
        phases: Array<{ name: string; steps: Array<{ fn: string; args?: Record<string, unknown> }> }>;
        onFailure?: Array<{ name: string; steps: Array<{ fn: string; args?: Record<string, unknown> }> }>;
      };
    }).props;
    expect(props.name).toBe("guarded-task");
    expect(props.phases.map((p) => p.name)).toEqual(["Create", "Checkpoint", "Run", "Destroy"]);
    // The checkpoint label the restore references is a static string (S4).
    const checkpoint = props.phases.find((p) => p.name === "Checkpoint")!.steps[0];
    expect(checkpoint.fn).toBe("spriteCheckpoint");
    expect(checkpoint.args).toMatchObject({ id: "task-1", comment: "pre-run" });
    // onFailure restores that same label.
    expect(props.onFailure?.map((p) => p.name)).toEqual(["Restore"]);
    const restore = props.onFailure![0].steps[0];
    expect(restore.fn).toBe("spriteRestore");
    expect(restore.args).toMatchObject({ id: "task-1", comment: "pre-run" });
  });
});

// ── Managed Agents worker — sprites-managed-agent-worker (#847) ──────────
// One per-session Op composing every Sprite config primitive: create → egress
// policy → keep-alive task → env-contract file → runner-as-service → run →
// release → destroy, with an onFailure that frees the hold and tears down. The
// activities + fake have offline coverage under lexicons/fly/src/op/activities/
// (sprite-tasks/config/fs .test.ts); this compile-validates the session shape.

describe("sprites-managed-agent-worker Op (#847)", () => {
  test("managed-agent-session composes the session phase sequence", () => {
    const props = (managedAgentSessionOp as unknown as {
      props: {
        name: string;
        taskQueue?: string;
        phases: Array<{ name: string; steps: Array<{ fn: string; args?: Record<string, unknown> }> }>;
        onFailure?: Array<{ name: string; steps: Array<{ fn: string }> }>;
      };
    }).props;
    expect(props.name).toBe("managed-agent-session");
    expect(props.taskQueue).toBe("sprites");
    expect(props.phases.map((p) => p.name)).toEqual([
      "Create",
      "Secure",
      "Hold",
      "Stage",
      "Runner",
      "Run",
      "Release",
      "Destroy",
    ]);
    // Each phase resolves to the right Sprite activity by name.
    expect(props.phases.map((p) => p.steps[0].fn)).toEqual([
      "spriteCreate",
      "spriteApplyNetworkPolicy",
      "spriteTaskCreate",
      "spriteWriteFile",
      "spriteApplyServices",
      "spriteExec",
      "spriteTaskRelease",
      "spriteDestroy",
    ]);
    // The egress policy allows Anthropic first and denies by default last.
    const secure = props.phases.find((p) => p.name === "Secure")!.steps[0];
    const rules = secure.args?.rules as Array<{ domain: string; action: string }>;
    expect(rules[0]).toMatchObject({ domain: "api.anthropic.com", action: "allow" });
    expect(rules[rules.length - 1]).toMatchObject({ domain: "*", action: "deny" });
    // onFailure frees the keep-alive hold and destroys the Sprite.
    expect(props.onFailure?.flatMap((p) => p.steps.map((s) => s.fn))).toEqual([
      "spriteTaskRelease",
      "spriteDestroy",
    ]);
  });
});

// ── Sprites build sandbox — sprites-build-sandbox (#869) ─────────────
// Disposable build box: warm a toolchain, checkpoint it (the prepared pool),
// build from staged source, collect the artifact, reset to the checkpoint,
// destroy. Compile-validates the phase sequence; the live run is in the tutorial.

describe("sprites-build-sandbox Op (#869)", () => {
  test("build-sandbox composes the warm → checkpoint → build → reset sequence", () => {
    const props = (buildSandboxOp as unknown as {
      props: { name: string; taskQueue?: string; phases: Array<{ name: string; steps: Array<{ fn: string; args?: Record<string, unknown> }> }> };
    }).props;
    expect(props.name).toBe("build-sandbox");
    expect(props.taskQueue).toBe("sprites");
    expect(props.phases.map((p) => p.name)).toEqual([
      "Create",
      "Warm",
      "Checkpoint",
      "Stage",
      "Build",
      "Collect",
      "Reset",
      "Destroy",
    ]);
    expect(props.phases.map((p) => p.steps[0].fn)).toEqual([
      "spriteCreate",
      "spriteExec",
      "spriteCheckpoint",
      "spriteWriteFile",
      "spriteExec",
      "spriteReadFile",
      "spriteRestore",
      "spriteDestroy",
    ]);
    // Reset restores the same checkpoint the Checkpoint phase wrote (the pool).
    const checkpoint = props.phases.find((p) => p.name === "Checkpoint")!.steps[0];
    const reset = props.phases.find((p) => p.name === "Reset")!.steps[0];
    expect(checkpoint.args?.comment).toBe("toolchain-ready");
    expect(reset.args?.comment).toBe("toolchain-ready");
  });
});

// ── Durable Fly deploy on Temporal — fly-durable-deploy (#870) ──────────
// The same App+Machine deploy as local-fly, but run as a durable Temporal Op:
// Build serializes src/infra.ts, Deploy applies it via flyApply. The live run
// (chant run fly-durable-deploy --temporal against mudflaps) is in the tutorial;
// here we compile-validate the two-phase shape and the flyApply activity.

describe("fly-durable-deploy Op (#870)", () => {
  test("composes Build → Deploy with flyApply on its own task queue", () => {
    const props = (flyDurableDeployOp as unknown as {
      props: { name: string; taskQueue?: string; phases: Array<{ name: string; steps: Array<{ fn: string }> }> };
    }).props;
    // Globally-unique Op name (must not collide with fly-deploy-rollback's "fly-deploy").
    expect(props.name).toBe("fly-durable-deploy");
    expect(props.taskQueue).toBe("fly-durable");
    expect(props.phases.map((p) => p.name)).toEqual(["Build", "Deploy"]);
    expect(props.phases.find((p) => p.name === "Build")!.steps[0].fn).toBe("chantBuild");
    expect(props.phases.find((p) => p.name === "Deploy")!.steps[0].fn).toBe("flyApply");
  });
});

// ── Fly agent deploy — fly-deploy-rollback ──────────────────────────────
// Composes local-fly (App+Machine → flaps) with sprites-agent-task
// (checkpoint-as-compensation): an agent deploys the Fly infra from inside a
// checkpointed Sprite, and a botched change rewinds the sandbox. The live run
// boots spritzer + mudflaps in Docker (out of CI's reach), so this block
// build-validates the Fly plan and compile-validates the two Ops, mirroring the
// local-fly + sprites-agent-task blocks above.

describeExample(
  "fly-deploy-rollback",
  {
    lexicon: "fly",
    serializer: [flySerializer],
    outputKey: "fly",
    examplesDir: import.meta.dirname,
  },
  {
    checks: (output) => {
      const plan = JSON.parse(output) as Record<
        string,
        { endpoint: string; method: string; body: Record<string, any> }
      >;
      const reqs = Object.values(plan);
      // App create body: POST /v1/apps { app_name, org_slug }. org_slug is
      // required by the Machines API (real Fly and mudflaps >=0.3.1 reject app
      // creation without it); Fly.OrgSlug resolves to "personal" offline.
      const app = reqs.find((r) => r.endpoint === "/v1/apps");
      expect(app).toBeDefined();
      expect(app!.body.app_name).toBe("fly-deploy-demo");
      expect(app!.body.org_slug).toBe("personal");
      // Machine create body under the app, with a config and the stamped marker.
      const machine = reqs.find((r) => /\/v1\/apps\/[^/]+\/machines$/.test(r.endpoint));
      expect(machine).toBeDefined();
      expect(machine!.endpoint).toBe("/v1/apps/fly-deploy-demo/machines");
      expect(machine!.body.config).toBeDefined();
      expect(machine!.body.config.image).toBe("flyio/hellofly:latest");
      expect(machine!.body.config.metadata["managed-by"]).toBe("chant");
    },
  },
);

describe("fly-deploy-rollback Ops", () => {
  test("deploy composes the sprite + fly phases (checkpoint → deploy)", () => {
    const props = (flyRollbackOp as unknown as {
      props: { name: string; taskQueue?: string; phases: Array<{ name: string; steps: Array<{ fn: string }> }> };
    }).props;
    expect(props.name).toBe("fly-deploy");
    expect(props.taskQueue).toBe("fly-deploy");
    // The optional Verify phase is env-gated (offline only), so assert the core
    // sequence with Verify filtered out — stable whether or not FLY_FLAPS_BASE_URL
    // is set when the Op module loads.
    const names = props.phases.map((p) => p.name).filter((n) => n !== "Verify");
    expect(names).toEqual(["Emulators", "Sandbox", "Checkpoint", "Build", "Deploy", "Teardown"]);
    // Emulators boots both fakes; Deploy applies the fly plan.
    const emulators = props.phases.find((p) => p.name === "Emulators")!;
    expect(emulators.steps.map((s) => s.fn)).toEqual(["spritesUp", "flapsUp"]);
    const checkpoint = props.phases.find((p) => p.name === "Checkpoint")!;
    expect(checkpoint.steps[0].fn).toBe("spriteCheckpoint");
    const deploy = props.phases.find((p) => p.name === "Deploy")!;
    expect(deploy.steps[0].fn).toBe("flyApply");
  });

  test("deploy-guarded rolls the sandbox back on a failed change (onFailure Restore)", () => {
    const props = (flyRollbackGuardedOp as unknown as {
      props: {
        name: string;
        phases: Array<{ name: string; steps: Array<{ fn: string; args?: Record<string, unknown> }> }>;
        onFailure?: Array<{ name: string; steps: Array<{ fn: string; args?: Record<string, unknown> }> }>;
      };
    }).props;
    expect(props.name).toBe("fly-deploy-guarded");
    expect(props.phases.map((p) => p.name)).toEqual([
      "Emulators",
      "Sandbox",
      "Checkpoint",
      "Build",
      "Deploy",
      "RiskyChange",
    ]);
    // The Checkpoint the restore targets is a static `known-good` label.
    const checkpoint = props.phases.find((p) => p.name === "Checkpoint")!.steps[0];
    expect(checkpoint.fn).toBe("spriteCheckpoint");
    expect(checkpoint.args).toMatchObject({ id: "deploy-sandbox", comment: "known-good" });
    // The risky change is the failing step that triggers the rollback.
    const risky = props.phases.find((p) => p.name === "RiskyChange")!.steps[0];
    expect(risky.fn).toBe("spriteExec");
    expect(risky.args).toMatchObject({ cmd: "./risky.sh" });
    // onFailure restores that same label, then proves + cleans up.
    expect(props.onFailure?.map((p) => p.name)).toEqual(["Rollback"]);
    const restore = props.onFailure![0].steps[0];
    expect(restore.fn).toBe("spriteRestore");
    expect(restore.args).toMatchObject({ id: "deploy-sandbox", comment: "known-good" });
  });
});

// ── Flux CD on self-hosted k8s — flux-apps (#1590) ──────────────────
// One FluxGitSource + three FluxAppFor calls reconcile a platform layer and
// two workloads out of one repo, with dependsOn ordering (platform ← api ←
// web). The workloads are plain Chant k8s (Traefik IngressRoute +
// cert-manager Certificate — the self-hosted stack); Flux is opt-in via
// src/flux. The live run needs a cluster (documented in the tutorial); CI
// builds the whole src tree — FLUX002/003's cross-resource joins hold
// because source and Kustomizations are declared in the same build.

describeExample(
  "flux-apps",
  {
    lexicon: "k8s",
    serializer: k8sSerializer,
    outputKey: "k8s",
    examplesDir: import.meta.dirname,
  },
  {
    checks: (output) => {
      const docs = parseK8sDocs(output);
      // 2 platform + 2 api + 4 web + 1 GitRepository + 3 Kustomizations = 12.
      // The README states this count — keep them in lockstep (#1422).
      expect(docs).toHaveLength(12);
      const kinds = docs.map((d) => d.kind);
      expect(kinds.filter((k) => k === "GitRepository")).toHaveLength(1);
      expect(kinds.filter((k) => k === "Kustomization")).toHaveLength(3);
      expect(kinds.filter((k) => k === "Deployment")).toHaveLength(2);
      expect(kinds.filter((k) => k === "Service")).toHaveLength(2);
      expect(kinds).toContain("Namespace");
      expect(kinds).toContain("ClusterIssuer");
      expect(kinds).toContain("Certificate");
      expect(kinds).toContain("IngressRoute");

      // The source pins a ref (FLUX001's default) at a 5m interval.
      const source = docs.find((d) => d.kind === "GitRepository")!;
      expect(source.doc).toContain("branch: main");
      expect(source.doc).toMatch(/interval: '?5m'?/);

      // Every Kustomization reconciles out of the one shared source, with
      // estate defaults on (one source, many apps; prune + wait).
      const kustomizations = docs.filter((d) => d.kind === "Kustomization");
      for (const k of kustomizations) {
        expect(k.doc).toContain("name: flux-apps");
        expect(k.doc).toContain("kind: GitRepository");
        expect(k.doc).toContain("prune: true");
        expect(k.doc).toContain("wait: true");
      }

      // The dependsOn graph: platform ← api ← web (FLUX003 validates the
      // names against this same build).
      const web = kustomizations.find((d) => d.name === "web")!;
      expect(web.doc).toContain("dependsOn");
      expect(web.doc).toContain("- name: platform");
      expect(web.doc).toContain("- name: api");
      const api = kustomizations.find((d) => d.name === "api")!;
      expect(api.doc).toContain("- name: platform");
      const platform = kustomizations.find((d) => d.name === "platform")!;
      expect(platform.doc).not.toContain("dependsOn");
    },
  },
);

// ── K8s + AWS EKS microservice (comprehensive) ──────────────────────

describe("k8s-eks-microservice example", () => {
  const srcDir = resolve(import.meta.dirname, "k8s-eks-microservice", "src");

  test("passes lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [awsSerializer, k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("aws")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  test("CloudFormation template contains all expected resources", async () => {
    const result = await build(srcDir, [awsSerializer]);
    expect(result.errors).toHaveLength(0);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    expect(parsed.AWSTemplateFormatVersion).toBe("2010-09-09");
    // 17 VPC + 1 cluster + 1 nodegroup + 1 OIDC + 8 IAM roles + 1 IAM policy + 4 addons + 1 KMS key + 1 HostedZone = 35
    expect(Object.keys(parsed.Resources)).toHaveLength(35);
    const types = Object.values(parsed.Resources).map((r: any) => r.Type);
    expect(types).toContain("AWS::EKS::Cluster");
    expect(types).toContain("AWS::EKS::Nodegroup");
    expect(types).toContain("AWS::IAM::OIDCProvider");
    expect(types).toContain("AWS::EC2::VPC");
    expect(types.filter((t: string) => t === "AWS::IAM::Role")).toHaveLength(8);
    expect(types.filter((t: string) => t === "AWS::EKS::Addon")).toHaveLength(4);
    expect(types).toContain("AWS::KMS::Key");
    expect(types).toContain("AWS::Route53::HostedZone");
  });

  test("EKS cluster has correct properties", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const cluster = parsed.Resources.cluster;
    expect(cluster.Type).toBe("AWS::EKS::Cluster");
    expect(cluster.Properties.Name).toBe("eks-microservice");
    expect(cluster.Properties.Version).toBe("1.31");
    const vpcConfig = cluster.Properties.ResourcesVpcConfig;
    expect(vpcConfig.SubnetIds).toHaveLength(4);
    expect(vpcConfig.EndpointPublicAccess).toBe(true);
    expect(vpcConfig.EndpointPrivateAccess).toBe(true);
    const encryption = cluster.Properties.EncryptionConfig;
    expect(encryption).toHaveLength(1);
    expect(encryption[0].Resources).toEqual(["secrets"]);
  });

  test("managed node group has correct scaling and instance config", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const ng = parsed.Resources.nodegroup;
    expect(ng.Type).toBe("AWS::EKS::Nodegroup");
    expect(ng.Properties.InstanceTypes).toEqual(["t3.medium"]);
    expect(ng.Properties.AmiType).toBe("AL2023_x86_64_STANDARD");
    const scaling = ng.Properties.ScalingConfig;
    expect(scaling.MinSize).toBe(2);
    expect(scaling.MaxSize).toBe(6);
    expect(scaling.DesiredSize).toBe(3);
  });

  test("IAM roles have correct trust policies", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const clusterRolePolicy =
      parsed.Resources.clusterRole.Properties.AssumeRolePolicyDocument;
    expect(clusterRolePolicy.Statement.Principal.Service).toBe(
      "eks.amazonaws.com",
    );
    const nodeRolePolicy =
      parsed.Resources.nodeRole.Properties.AssumeRolePolicyDocument;
    expect(nodeRolePolicy.Statement.Principal.Service).toBe(
      "ec2.amazonaws.com",
    );
    const appRolePolicy =
      parsed.Resources.appRole.Properties.AssumeRolePolicyDocument;
    expect(appRolePolicy["Fn::Sub"]).toBeDefined();
    const [template] = appRolePolicy["Fn::Sub"];
    expect(template).toContain("sts:AssumeRoleWithWebIdentity");
    expect(template).toContain(
      "system:serviceaccount:microservice:microservice-app-sa",
    );
  });

  test("OIDC provider references cluster", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const oidc = parsed.Resources.oidcProvider;
    expect(oidc.Type).toBe("AWS::IAM::OIDCProvider");
    expect(oidc.Properties.ClientIdList).toEqual(["sts.amazonaws.com"]);
  });

  test("stack outputs expose all required ARNs and IDs", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const outputNames = Object.keys(parsed.Outputs);
    for (const name of [
      "vpcId",
      "publicSubnet1Id",
      "publicSubnet2Id",
      "privateSubnet1Id",
      "privateSubnet2Id",
      "clusterEndpoint",
      "clusterArnOutput",
      "appRoleArn",
      "albControllerRoleArn",
      "externalDnsRoleArn",
      "fluentBitRoleArn",
      "adotRoleArn",
      "hostedZoneIdOutput",
    ]) {
      expect(outputNames).toContain(name);
    }
    expect(outputNames).toHaveLength(13);
  });

  test("K8s output contains all expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    expect(docs).toHaveLength(36);
    const kinds = docs.map((d) => d.kind);
    expect(kinds.filter((k) => k === "Deployment")).toHaveLength(3);
    expect(kinds.filter((k) => k === "Service")).toHaveLength(2);
    expect(kinds.filter((k) => k === "ServiceAccount")).toHaveLength(5);
    expect(kinds.filter((k) => k === "DaemonSet")).toHaveLength(2);
    expect(kinds.filter((k) => k === "Namespace")).toHaveLength(3);
  });

  test("IRSA ServiceAccount has role-arn annotation", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const appSa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name === "microservice-app-sa",
    );
    expect(appSa).toBeDefined();
    expect(appSa!.doc).toContain("eks.amazonaws.com/role-arn");
  });

  test("ALB Ingress has correct annotations", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const ingress = docs.find((d) => d.kind === "Ingress");
    expect(ingress).toBeDefined();
    expect(ingress!.doc).toContain(
      "alb.ingress.kubernetes.io/scheme: internet-facing",
    );
    expect(ingress!.doc).toContain(
      "alb.ingress.kubernetes.io/target-type: ip",
    );
    expect(ingress!.doc).toContain("ingressClassName: alb");
  });

  test("app resources are in the microservice namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const name of [
      "microservice-api",
      "microservice-app-sa",
      "microservice-alb",
    ]) {
      const doc = docs.find((d) => d.name === name);
      expect(doc).toBeDefined();
      expect(doc!.doc).toContain("namespace: microservice");
    }
  });

  test("all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });

  test("generated K8s YAML passes all post-synth error-level checks", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const ctx: PostSynthContext = {
      outputs: result.outputs,
      entities: result.entities,
      buildResult: {
        outputs: result.outputs,
        entities: result.entities,
        warnings: result.warnings ?? [],
        errors: result.errors,
        sourceFileCount: 1,
      },
    };
    const allChecks = k8sPlugin.postSynthChecks!();
    const allDiags = allChecks.flatMap((c) => c.check(ctx));
    const errors = allDiags.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.log(
        "Post-synth errors:",
        errors.map((e) => `${e.checkId}: ${e.message}`),
      );
    }
    expect(errors).toEqual([]);
  });
});

// ── K8s + GCP GKE microservice (comprehensive) ──────────────────────

describe("k8s-gke-microservice example", () => {
  const srcDir = resolve(import.meta.dirname, "k8s-gke-microservice", "src");

  test("passes lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [gcpSerializer, k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("gcp")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  test("GCP Config Connector output contains all expected resources", async () => {
    const result = await build(srcDir, [gcpSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = result.outputs.get("gcp")!.split("---").filter((d) => d.trim());
    // 4 SAs + 8 IAM bindings + DNS zone = 13
    // (VPC/cluster composites return plain objects — not yet generated as Declarables)
    expect(docs.length).toBeGreaterThanOrEqual(13);
    const kinds = docs.map((d) => d.match(/kind:\s+(\S+)/)?.[1] ?? "");
    expect(kinds.filter((k) => k === "IAMServiceAccount").length).toBeGreaterThanOrEqual(4);
    expect(kinds.filter((k) => k === "IAMPolicyMember").length).toBeGreaterThanOrEqual(8);
    expect(kinds).toContain("DNSManagedZone");
  });

  test("IAM bindings reference correct SA emails", async () => {
    const result = await build(srcDir, [gcpSerializer]);
    const output = result.outputs.get("gcp")!;
    expect(output).toContain("gke-microservice-app");
    expect(output).toContain("gke-microservice-dns");
    expect(output).toContain("gke-microservice-logging");
    expect(output).toContain("gke-microservice-monitoring");
    expect(output).toContain("roles/iam.workloadIdentityUser");
    expect(output).toContain("roles/dns.admin");
    expect(output).toContain("roles/logging.logWriter");
    expect(output).toContain("roles/monitoring.metricWriter");
    expect(output).toContain("roles/cloudtrace.agent");
  });

  test("K8s output contains all expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    expect(docs.length).toBeGreaterThanOrEqual(28);
    const kinds = docs.map((d) => d.kind);
    expect(kinds.filter((k) => k === "Deployment")).toHaveLength(2);
    expect(kinds.filter((k) => k === "Service")).toHaveLength(1);
    expect(kinds.filter((k) => k === "ServiceAccount")).toHaveLength(4);
    expect(kinds.filter((k) => k === "DaemonSet")).toHaveLength(2);
    expect(kinds.filter((k) => k === "Namespace")).toHaveLength(3);
    expect(kinds.filter((k) => k === "Ingress")).toHaveLength(1);
  });

  test("Workload Identity SA has iam.gke.io/gcp-service-account annotation", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const appSa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name === "microservice-app-sa",
    );
    expect(appSa).toBeDefined();
    expect(appSa!.doc).toContain("iam.gke.io/gcp-service-account");
  });

  test("GCE Ingress has correct annotations", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const ingress = docs.find((d) => d.kind === "Ingress");
    expect(ingress).toBeDefined();
    expect(ingress!.doc).toContain("kubernetes.io/ingress.class: gce");
  });

  test("app resources are in the microservice namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const name of [
      "microservice-api",
      "microservice-app-sa",
      "microservice-ingress",
    ]) {
      const doc = docs.find((d) => d.name === name);
      expect(doc).toBeDefined();
      expect(doc!.doc).toContain("namespace: microservice");
    }
  });

  test("all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });

  test("generated K8s YAML passes all post-synth error-level checks", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const ctx: PostSynthContext = {
      outputs: result.outputs,
      entities: result.entities,
      buildResult: {
        outputs: result.outputs,
        entities: result.entities,
        warnings: result.warnings ?? [],
        errors: result.errors,
        sourceFileCount: 1,
      },
    };
    const allChecks = k8sPlugin.postSynthChecks!();
    const allDiags = allChecks.flatMap((c) => c.check(ctx));
    const errors = allDiags.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.log(
        "Post-synth errors:",
        errors.map((e) => `${e.checkId}: ${e.message}`),
      );
    }
    expect(errors).toEqual([]);
  });
});

// ── K8s + Azure AKS microservice (comprehensive) ────────────────────

describe("k8s-aks-microservice example", () => {
  const srcDir = resolve(import.meta.dirname, "k8s-aks-microservice", "src");

  test("passes lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [azureSerializer, k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("azure")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  test("ARM template contains all expected resources", async () => {
    const result = await build(srcDir, [azureSerializer]);
    expect(result.errors).toHaveLength(0);
    const parsed = JSON.parse(result.outputs.get("azure")!);
    expect(parsed.$schema).toContain("deploymentTemplate.json");
    const types = parsed.resources.map((r: any) => r.type);
    expect(types).toContain("Microsoft.ContainerService/managedClusters");
    expect(types).toContain("Microsoft.ContainerRegistry/registries");
    expect(types).toContain("Microsoft.Network/virtualNetworks");
    expect(types.filter((t: string) => t === "Microsoft.ManagedIdentity/userAssignedIdentities")).toHaveLength(3);
    expect(types.filter((t: string) => t === "Microsoft.Authorization/roleAssignments")).toHaveLength(3);
    expect(types).toContain("Microsoft.Network/dnsZones");
  });

  test("AKS cluster has correct properties", async () => {
    const result = await build(srcDir, [azureSerializer]);
    const parsed = JSON.parse(result.outputs.get("azure")!);
    const cluster = parsed.resources.find(
      (r: any) => r.type === "Microsoft.ContainerService/managedClusters",
    );
    expect(cluster).toBeDefined();
    expect(cluster.name).toBe("aks-microservice");
    expect(cluster.properties.kubernetesVersion).toBe("1.32");
    expect(cluster.properties.agentPoolProfiles[0].count).toBe(3);
    expect(cluster.properties.agentPoolProfiles[0].vmSize).toBe("Standard_B2s");
    expect(cluster.properties.enableRBAC).toBe(true);
  });

  test("K8s output contains all expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    expect(docs.length).toBeGreaterThanOrEqual(22);
    const kinds = docs.map((d) => d.kind);
    expect(kinds.filter((k) => k === "Deployment")).toHaveLength(2);
    expect(kinds.filter((k) => k === "Service")).toHaveLength(1);
    expect(kinds.filter((k) => k === "ServiceAccount")).toHaveLength(3);
    expect(kinds.filter((k) => k === "DaemonSet")).toHaveLength(1);
    expect(kinds.filter((k) => k === "Namespace")).toHaveLength(2);
  });

  test("Workload Identity SA has azure.workload.identity/client-id annotation", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const appSa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name === "microservice-app-sa",
    );
    expect(appSa).toBeDefined();
    expect(appSa!.doc).toContain("azure.workload.identity/client-id");
  });

  test("AGIC Ingress has correct annotations", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const ingress = docs.find((d) => d.kind === "Ingress");
    expect(ingress).toBeDefined();
    expect(ingress!.doc).toContain("kubernetes.io/ingress.class: azure/application-gateway");
  });

  test("app resources are in the microservice namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const name of [
      "microservice-api",
      "microservice-app-sa",
      "microservice-agic",
    ]) {
      const doc = docs.find((d) => d.name === name);
      expect(doc).toBeDefined();
      expect(doc!.doc).toContain("namespace: microservice");
    }
  });

  test("all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });

  test("generated K8s YAML passes all post-synth error-level checks", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const ctx: PostSynthContext = {
      outputs: result.outputs,
      entities: result.entities,
      buildResult: {
        outputs: result.outputs,
        entities: result.entities,
        warnings: result.warnings ?? [],
        errors: result.errors,
        sourceFileCount: 1,
      },
    };
    const allChecks = k8sPlugin.postSynthChecks!();
    const allDiags = allChecks.flatMap((c) => c.check(ctx));
    const errors = allDiags.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.log(
        "Post-synth errors:",
        errors.map((e) => `${e.checkId}: ${e.message}`),
      );
    }
    expect(errors).toEqual([]);
  });
});

// ── GCP GitLab Cells (single-region, multi-cell) ─────────────────────

describe("gitlab-cells-single-region-gke example", () => {
  const srcDir = resolve(import.meta.dirname, "gitlab-cells-single-region-gke", "src");

  test("passes lint", async () => {
    const result = await lintCommand({ path: srcDir, format: "stylish", fix: true });
    if (!result.success || result.errorCount > 0) console.log(result.output);
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  test("GCP build succeeds with expected resources", async () => {
    const result = await build(srcDir, [gcpSerializer]);
    expect(result.errors).toHaveLength(0);
    const output = result.outputs.get("gcp")!;
    expect(output).toContain("ContainerCluster");
    expect(output).toContain("SQLInstance");
    expect(output).toContain("RedisInstance");
    expect(output).toContain("SecretManagerSecret");
    expect(output).toContain("DNSManagedZone");
  });

  test("K8s build succeeds with expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const kinds = docs.map((d) => d.kind);
    const namespaces = docs.filter((d) => d.kind === "Namespace").map((d) => d.name);
    expect(namespaces).toContain("system");
    expect(kinds).toContain("StorageClass");
    expect(kinds).toContain("Deployment");
    expect(kinds).toContain("ConfigMap");
  });

  test("Helm build succeeds", async () => {
    const result = await build(srcDir, [helmSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("helm")).toBe(true);
  });

  test("GitLab CI build succeeds with expected stages", async () => {
    const result = await build(srcDir, [gitlabSerializer]);
    expect(result.errors).toHaveLength(0);
    const yaml = result.outputs.get("gitlab")!;
    expect(yaml).toContain("stage: infra");
    expect(yaml).toContain("stage: system");
    expect(yaml).toContain("stage: deploy-canary");
  });
});

// ── Ray / KubeRay on GKE ──────────────────────────────────────────────

describe("ray-kuberay-gke example", () => {
  const srcDir = resolve(import.meta.dirname, "ray-kuberay-gke", "src");

  test("passes lint", async () => {
    const result = await lintCommand({ path: srcDir, format: "stylish", fix: true });
    if (!result.success || result.errorCount > 0) console.log(result.output);
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  test("GCP build succeeds with expected resources", async () => {
    const result = await build(srcDir, [gcpSerializer]);
    expect(result.errors).toHaveLength(0);
    const output = result.outputs.get("gcp")!;
    expect(output).toContain("ContainerCluster");
    expect(output).toContain("NodePool");
    expect(output).toContain("FilestoreInstance");
    expect(output).toContain("StorageBucket");
    expect(output).toContain("IAMServiceAccount");
    expect(output).toContain("IAMPolicyMember");
    expect(output).toContain("roles/iam.workloadIdentityUser");
    expect(output).toContain("roles/storage.objectAdmin");
  });

  test("K8s build succeeds with expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const kinds = docs.map((d) => d.kind);
    expect(kinds).toContain("Namespace");
    expect(kinds).toContain("NetworkPolicy");
    expect(kinds).toContain("PodDisruptionBudget");
    expect(kinds).toContain("PersistentVolumeClaim");
    expect(kinds).toContain("ServiceAccount");
    expect(kinds).toContain("ClusterRole");
    expect(kinds).toContain("ClusterRoleBinding");
    expect(kinds).toContain("RayCluster");
  });

  test("RayCluster CR has production defaults", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const output = result.outputs.get("k8s")!;
    // preStop hook — serialized as array ["ray", "stop"]
    expect(output).toContain("preStop");
    // terminationGracePeriodSeconds
    expect(output).toContain("120");
    // Spillover bucket config
    expect(output).toContain("RAY_object_spilling_config");
    // num-cpus derived from resources.cpu
    expect(output).toContain("num-cpus");
    // Workload Identity annotation on ServiceAccount
    expect(output).toContain("iam.gke.io/gcp-service-account");
  });

  test("NetworkPolicy uses podSelector for intra-cluster rules", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const output = result.outputs.get("k8s")!;
    const docs = parseK8sDocs(output);
    const netpol = docs.find((d) => d.kind === "NetworkPolicy")!;
    expect(netpol).toBeDefined();
    // podSelector-based rules (no ipBlock for intra-cluster)
    expect(netpol.doc).toContain("ray.io/cluster-name");
    // GCS egress with RFC1918 exclusion
    expect(netpol.doc).toContain("0.0.0.0/0");
    expect(netpol.doc).toContain("10.0.0.0/8");
  });
});
