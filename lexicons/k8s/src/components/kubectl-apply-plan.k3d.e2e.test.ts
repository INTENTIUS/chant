/**
 * `kubectl-apply` plan against a real API server (#3998).
 *
 * Skipped unless `CHANT_K3D_CONTEXT` names a kubeconfig context, such as
 * the one `k3d cluster create chant-e2e` writes (`k3d-chant-e2e`). Each run
 * works in a namespace of its own and deletes it afterwards.
 *
 * What only a real server shows: the defaults it fills in on a dry run match
 * the live object's, so applying a manifest and planning it again plans no
 * change.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";
import { createKubectlApplyCapability, KubectlApplyPlanMovedError, type KubectlApplyInput } from "./kubectl-apply";

const context = process.env.CHANT_K3D_CONTEXT;
const suffix = Math.random().toString(36).slice(2, 8);
const ns = `chant-plan-${suffix}`;
const stack = `plan-e2e-${suffix}`;

const namespace = { apiVersion: "v1", kind: "Namespace", metadata: { name: ns } };
const config = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg", namespace: ns }, data: { a: "1" } };
const deployment = (replicas: number, app = "web") => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: ns },
  spec: {
    replicas,
    selector: { matchLabels: { app } },
    template: {
      metadata: { labels: { app } },
      spec: { containers: [{ name: "pause", image: "registry.k8s.io/pause:3.9" }] },
    },
  },
});

describe.skipIf(!context)("kubectl-apply plan on k3d (#3998)", () => {
  let dir: string;
  const cap = createKubectlApplyCapability();
  const ctx = { env: "e2e", component: "web" };
  const write = (documents: object[]): string => {
    const file = join(dir, `k8s-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(file, documents.map((d) => dump(d)).join("---\n"));
    return file;
  };
  const input = (documents: object[], extra: Partial<KubectlApplyInput> = {}): KubectlApplyInput => ({
    manifest: write(documents),
    stack,
    context: context!,
    ...extra,
  });
  const actions = (entries: Array<{ address: string; action: string }>) =>
    Object.fromEntries(entries.map((e) => [e.address, e.action]));

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-3998-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    execFileSync("kubectl", ["--context", context!, "delete", "namespace", ns, "--wait=false", "--ignore-not-found"]);
  });

  test("a new manifest plans creates, the namespace's objects included, and run applies the plan", async () => {
    const step = input([namespace, config, deployment(1)]);
    const planned = await cap.plan!(ctx, step);
    expect(planned.member).toBe(stack);
    expect(actions(planned.changeSet!.entries)).toEqual({
      [`Namespace/${ns}`]: "create",
      [`ConfigMap/${ns}/cfg`]: "create",
      [`Deployment/${ns}/web`]: "create",
    });
    const applied = await cap.run({ ...ctx, plans: { [stack]: planned.artifact } }, step);
    expect(applied.applied.map((r) => r.kind)).toEqual(["Namespace", "ConfigMap", "Deployment"]);
  }, 60_000);

  test("the same manifest planned again is no change: server defaults and bookkeeping drop out", async () => {
    const planned = await cap.plan!(ctx, input([namespace, config, deployment(1)]));
    expect(planned.changeSet!.entries.map((e) => [e.address, e.action, e.attributes])).toEqual([
      [`Namespace/${ns}`, "no-op", []],
      [`ConfigMap/${ns}/cfg`, "no-op", []],
      [`Deployment/${ns}/web`, "no-op", []],
    ]);
  }, 60_000);

  test("a changed field is an update naming it, and owned-only plans the removed object's delete", async () => {
    const planned = await cap.plan!(ctx, input([namespace, deployment(2)], { delete: "owned-only" }));
    const byAddress = Object.fromEntries(planned.changeSet!.entries.map((e) => [e.address, e]));
    expect(byAddress[`Deployment/${ns}/web`]).toMatchObject({
      action: "update",
      disruption: "in-place",
      attributes: [{ path: "spec.replicas", before: 1, after: 2 }],
    });
    expect(byAddress[`ConfigMap/${ns}/cfg`]).toMatchObject({ action: "delete", disruption: "destroy" });
    expect(byAddress[`Namespace/${ns}`]).toMatchObject({ action: "no-op" });
  }, 60_000);

  test("run refuses an approved plan once the cluster moved, and applies nothing", async () => {
    // Approved while nothing undeclared is owned: no deletes.
    const approved = await cap.plan!(ctx, input([namespace, config, deployment(2)], { delete: "owned-only" }));
    expect(approved.changeSet!.entries.some((e) => e.action === "delete")).toBe(false);
    // Then another apply under the same stack adds an owned object the approved manifest does not declare.
    const extra = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "extra", namespace: ns }, data: { b: "2" } };
    await cap.run(ctx, input([namespace, config, extra, deployment(1)]));
    const moved = cap.run(
      { ...ctx, plans: { [stack]: approved.artifact } },
      input([namespace, config, deployment(2)], { delete: "owned-only" }),
    );
    await expect(moved).rejects.toBeInstanceOf(KubectlApplyPlanMovedError);
    const kubectl = (...args: string[]) => String(execFileSync("kubectl", ["--context", context!, "-n", ns, ...args]));
    expect(kubectl("get", "configmap", "extra", "-o", "jsonpath={.data.b}")).toBe("2");
    expect(kubectl("get", "deployment", "web", "-o", "jsonpath={.spec.replicas}")).toBe("1");
  }, 60_000);

  test("an immutable selector change is an update with a hole saying the apply would fail", async () => {
    const planned = await cap.plan!(ctx, input([namespace, config, deployment(1, "web2")]));
    const entry = planned.changeSet!.entries.find((e) => e.address === `Deployment/${ns}/web`);
    expect(entry).toMatchObject({ action: "update", disruption: "unknown" });
    expect(planned.changeSet!.member.holes).toEqual([
      expect.objectContaining({ address: `Deployment/${ns}/web`, reason: expect.stringMatching(/immutable/) }),
    ]);
  }, 60_000);
});
