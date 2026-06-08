import { describe, test, expect } from "vitest";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { describeCommand } from "./describe";

// The #203 layered-config example: one WebApp instantiated for dev/staging/prod
// from layered (spread) config. describe v1 projects the effective, resolved
// config for one named component over it.
const exampleSrc = resolve(
  fileURLToPath(import.meta.url),
  "../../../../../../lexicons/k8s/examples/layered-config/src",
);

function opts(component: string, format: "text" | "json" = "json") {
  return { component, path: exampleSrc, format };
}

describe("describeCommand (resolved view, v1)", () => {
  test("describes a composite instance by its export name (grouped resources)", async () => {
    const r = await describeCommand(opts("prodApp"));
    expect(r.success).toBe(true);
    expect(r.composite).toBe(true);
    const names = r.resources.map((x) => x.name).sort();
    expect(names).toEqual([
      "prodAppDeployment",
      "prodAppIngress",
      "prodAppPdb",
      "prodAppService",
    ]);
  });

  test("shows the effective, fully-resolved props (post-merge)", async () => {
    const r = await describeCommand(opts("prodApp"));
    const dep = r.resources.find((x) => x.entityType.endsWith("Deployment"))!;
    const props = dep.props as { spec: { replicas: number }; metadata: { labels: Record<string, string> } };
    // prod overrode replicas; base labels merged with prod-only ones.
    expect(props.spec.replicas).toBe(6);
    expect(props.metadata.labels["app.kubernetes.io/part-of"]).toBe("acme-web"); // base layer
    expect(props.metadata.labels["acme.io/env"]).toBe("prod"); // env layer
    expect(props.metadata.labels["acme.io/tier"]).toBe("critical"); // prod-only
  });

  test("environments resolve to different effective configs", async () => {
    const dev = await describeCommand(opts("devApp"));
    const devDep = dev.resources.find((x) => x.entityType.endsWith("Deployment"))!;
    const devProps = devDep.props as { spec: { replicas: number }; metadata: { labels: Record<string, string> } };
    expect(devProps.spec.replicas).toBe(2); // base default, not overridden in dev
    expect(devProps.metadata.labels["acme.io/env"]).toBe("dev");
    expect(devProps.metadata.labels["acme.io/tier"]).toBeUndefined(); // prod-only key absent
    // dev declares no ingress; prod does.
    expect(dev.resources.some((x) => x.entityType.endsWith("Ingress"))).toBe(false);
  });

  test("describes a single declarable by exact name (not a composite)", async () => {
    const r = await describeCommand(opts("devAppService"));
    expect(r.success).toBe(true);
    expect(r.composite).toBe(false);
    expect(r.resources).toHaveLength(1);
    expect(r.resources[0].entityType).toBe("K8s::Core::Service");
  });

  test("unknown component fails with the known-component list", async () => {
    const r = await describeCommand(opts("doesNotExist"));
    expect(r.success).toBe(false);
    expect(r.output).toContain("No component");
    expect(r.output).toContain("prodAppDeployment");
  });

  test("text format renders the component header and props", async () => {
    const r = await describeCommand(opts("prodApp", "text"));
    expect(r.output).toContain("prodApp");
    expect(r.output).toContain("K8s::Apps::Deployment");
    expect(r.output).toContain("web-prod");
  });
});
