import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { k3d101 } from "./k3d101";
import { k3d102 } from "./k3d102";

function ctx(yaml: string): PostSynthContext {
  const outputs = new Map<string, string>([["k3d", yaml]]);
  return {
    outputs,
    entities: new Map(),
    buildResult: { outputs, entities: new Map(), warnings: [] },
  } as unknown as PostSynthContext;
}

const HEADER = "apiVersion: k3d.io/v1alpha5\nkind: Simple\n";

describe("K3D101: malformed nodeFilters", () => {
  test("accepts every documented form", () => {
    const yaml =
      HEADER +
      `ports:
  - port: "8080:80"
    nodeFilters: ["loadbalancer", "server:0", "server:*", "agent:1", "all", "loadbalancer:proxy", "server:0:direct"]
`;
    expect(k3d101.check(ctx(yaml))).toHaveLength(0);
  });

  test("flags a typo'd role", () => {
    const yaml = HEADER + `volumes:\n  - volume: /tmp/x:/x\n    nodeFilters: ["sevrer:0"]\n`;
    const diags = k3d101.check(ctx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("K3D101");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("sevrer:0");
  });

  test("flags a malformed index", () => {
    const diags = k3d101.check(ctx(HEADER + `ports:\n  - port: "1:1"\n    nodeFilters: ["server:one"]\n`));
    expect(diags).toHaveLength(1);
  });

  test("ignores output that is not a k3d config", () => {
    const outputs = new Map<string, string>([["k8s", "kind: Deployment\nmetadata:\n  name: x\n"]]);
    const context = {
      outputs,
      entities: new Map(),
      buildResult: { outputs, entities: new Map(), warnings: [] },
    } as unknown as PostSynthContext;
    expect(k3d101.check(context)).toHaveLength(0);
  });
});

describe("K3D102: proxy password in the emitted config", () => {
  test("flags a password that landed in the artifact", () => {
    const yaml =
      HEADER +
      `registries:
  create:
    name: myregistry
    proxy:
      remoteURL: https://registry-1.docker.io
      password: hunter2
`;
    const diags = k3d102.check(ctx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("K3D102");
    expect(diags[0].severity).toBe("error");
  });

  test("silent when there is no proxy or no password", () => {
    expect(k3d102.check(ctx(HEADER + "servers: 1\n"))).toHaveLength(0);
    const noPass =
      HEADER + `registries:\n  create:\n    name: r\n    proxy:\n      remoteURL: https://x\n`;
    expect(k3d102.check(ctx(noPass))).toHaveLength(0);
  });
});
