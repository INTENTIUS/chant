import { describe, test, expect } from "vitest";
import { resolveKubeTarget, isTargetError, matchLiveObject } from "./target";
import { fakeDeclarable, fakeProjectContext } from "./testing";

describe("resolveKubeTarget (chant #1079)", () => {
  test("kubectl-style: <kind> <name> — never consults the project even when a project is present", () => {
    const project = fakeProjectContext({
      web: fakeDeclarable("K8s::Apps::Deployment", { metadata: { name: "different-name", namespace: "prod" } }),
    });
    const target = resolveKubeTarget(["deployment", "web"], undefined, project);
    expect(isTargetError(target)).toBe(false);
    if (!isTargetError(target)) {
      expect(target.selector).toEqual({ resource: "deployment" });
      expect(target.name).toBe("web");
      expect(target.declaredMatch).toBeUndefined();
    }
  });

  test("kubectl-style: a bare <kind> lists — name is undefined", () => {
    const target = resolveKubeTarget(["deployments"], undefined, undefined);
    if (!isTargetError(target)) {
      expect(target.name).toBeUndefined();
    } else {
      throw new Error("expected a resolved target");
    }
  });

  test("chant vocabulary: a single token matching a declared entity resolves via its own metadata", () => {
    const project = fakeProjectContext({
      myWeb: fakeDeclarable("K8s::Apps::Deployment", { metadata: { name: "web", namespace: "prod" } }),
    });
    const target = resolveKubeTarget(["myWeb"], undefined, project);
    if (isTargetError(target)) throw new Error("expected a resolved target");
    expect(target.selector).toEqual({ apiVersion: "apps/v1", kind: "Deployment" });
    expect(target.name).toBe("web");
    expect(target.namespace).toBe("prod");
    expect(target.declaredMatch?.entityName).toBe("myWeb");
  });

  test("an explicit -n overrides the declared namespace", () => {
    const project = fakeProjectContext({
      myWeb: fakeDeclarable("K8s::Apps::Deployment", { metadata: { name: "web", namespace: "prod" } }),
    });
    const target = resolveKubeTarget(["myWeb"], "staging", project);
    if (isTargetError(target)) throw new Error("expected a resolved target");
    expect(target.namespace).toBe("staging");
  });

  test("no arguments is an error, not a crash", () => {
    const target = resolveKubeTarget([], undefined, undefined);
    expect(isTargetError(target)).toBe(true);
  });
});

describe("matchLiveObject", () => {
  test("undefined project means no match, cheaply (no iteration)", () => {
    expect(matchLiveObject(undefined, { apiVersion: "v1", kind: "Pod", name: "a" })).toBeUndefined();
  });

  test("matches on apiVersion + kind + name + namespace, all four", () => {
    const project = fakeProjectContext({
      web: fakeDeclarable("K8s::Apps::Deployment", { metadata: { name: "web", namespace: "prod" } }),
    });
    expect(matchLiveObject(project, { apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" })?.entityName).toBe("web");
    expect(matchLiveObject(project, { apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "staging" })).toBeUndefined();
  });
});
