/**
 * Typed failure → observation tri-state (chant #1074 over #1089).
 *
 * The point of the move is that these verdicts are read off `code` and
 * `reason` rather than matched against English. The cases below are the same
 * ones `classifyKubectlFailure` covers in core, driven by the client's real
 * error objects, so the contract can be compared side by side.
 */

import { describe, test, expect } from "vitest";
import {
  ExecCredentialNotAllowedError,
  K8sApiError,
  K8sClientUnavailableError,
  K8sTransportError,
  KubeConfigError,
  UnknownResourceError,
} from "@intentius/chant-k8s-client";
import { classifyApiFailure, isMissingClientPackage, isWholeLexiconFailure, MISSING_CLIENT_DETAIL } from "./classify";

const status = (code: number, reason: string) => new K8sApiError(code, reason, "message", "apps/v1 Deployment prod/web");

describe("classifyApiFailure", () => {
  test("a NotFound is an absence — the only shape that may become a create", () => {
    expect(classifyApiFailure(status(404, "NotFound"))).toEqual({ kind: "absent" });
  });

  test("a kind the cluster does not serve is an absence too — no instance of it can exist", () => {
    // The rule core already had for `the server doesn't have a resource type`,
    // and the reason it had it: the usual cause is a CRD this very plan has not
    // applied yet, and calling it a hole would suppress the needed create.
    expect(classifyApiFailure(new UnknownResourceError("widgets.example.com/v1 Widget"))).toEqual({ kind: "absent" });
  });

  test.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ])("HTTP %i proves nothing about existence → no-credentials", (code, reason) => {
    expect(classifyApiFailure(status(code, reason))).toMatchObject({ kind: "unobserved", reason: "no-credentials" });
  });

  test.each([
    [409, "Conflict"],
    [429, "TooManyRequests"],
    [500, "InternalError"],
    [503, "ServiceUnavailable"],
  ])("HTTP %i → read-failed", (code, reason) => {
    expect(classifyApiFailure(status(code, reason))).toMatchObject({ kind: "unobserved", reason: "read-failed" });
  });

  test("a transport failure is no-binding — the same verdict kubectl's 'unable to connect' produced", () => {
    const err = new K8sTransportError("connect ECONNREFUSED 127.0.0.1:6443", "apps/v1 Deployment prod/web");
    expect(classifyApiFailure(err)).toMatchObject({ kind: "unobserved", reason: "no-binding" });
  });

  test("an unusable kubeconfig is no-binding", () => {
    expect(classifyApiFailure(new KubeConfigError("no context named prod-eks"))).toMatchObject({
      kind: "unobserved",
      reason: "no-binding",
    });
  });

  test("a refused credential plugin is no-credentials", () => {
    expect(classifyApiFailure(new ExecCredentialNotAllowedError("harvest", ["aws"]))).toMatchObject({
      kind: "unobserved",
      reason: "no-credentials",
    });
  });

  test("a missing client package is read-failed, never an absence", () => {
    expect(classifyApiFailure(new K8sClientUnavailableError())).toMatchObject({
      kind: "unobserved",
      reason: "read-failed",
    });
  });

  test("anything unrecognized is read-failed rather than assumed absent", () => {
    expect(classifyApiFailure(new Error("something else entirely"))).toMatchObject({
      kind: "unobserved",
      reason: "read-failed",
    });
    expect(classifyApiFailure("a string")).toMatchObject({ kind: "unobserved", reason: "read-failed" });
    expect(classifyApiFailure(undefined)).toMatchObject({ kind: "unobserved", reason: "read-failed" });
  });

  test("the detail is one line, capped", () => {
    const long = new K8sApiError(500, "InternalError", "x".repeat(500));
    const outcome = classifyApiFailure(long);
    expect(outcome.kind).toBe("unobserved");
    if (outcome.kind === "unobserved") {
      expect(outcome.detail.length).toBeLessThanOrEqual(200);
      expect(outcome.detail).not.toContain("\n");
    }
  });

  test("the detail names the context the client read, when the failure carries it (#1488)", () => {
    const err = status(500, "InternalError");
    err.contextNote = 'context "k3d-kubemicrovm-local" (ambient; no k8s.profiles.local binding)';
    const outcome = classifyApiFailure(err);
    expect(outcome.kind).toBe("unobserved");
    if (outcome.kind === "unobserved") {
      expect(outcome.detail).toContain('context "k3d-kubemicrovm-local" (ambient; no k8s.profiles.local binding)');
    }
  });

  test("the context note leads the detail, so it survives the one-line cap and any consumer truncation (#1488, #1620)", () => {
    const err = new K8sApiError(500, "InternalError", "x".repeat(500));
    err.contextNote = 'context "prod-eks" (bound by k8s.profiles.prod.context)';
    const outcome = classifyApiFailure(err);
    expect(outcome.kind).toBe("unobserved");
    if (outcome.kind === "unobserved") {
      expect(outcome.detail.startsWith('context "prod-eks" (bound by k8s.profiles.prod.context)')).toBe(true);
      // The error itself still follows — leading with the cluster does not
      // cost the message.
      expect(outcome.detail).toContain("xxx");
    }
  });

  test("the context appears within the first 160 chars of a long multi-line error's detail (#1620)", () => {
    // behold's estate overlay truncates a reason to its first line / 160 chars;
    // the context must land inside that window or it vanishes exactly on the
    // failures long enough to need it.
    const err = new K8sApiError(500, "InternalError", `${"y".repeat(300)}\n${"z".repeat(300)}`);
    err.contextNote = 'context "prod-eks" (bound by k8s.profiles.prod.context)';
    const outcome = classifyApiFailure(err);
    expect(outcome.kind).toBe("unobserved");
    if (outcome.kind === "unobserved") {
      const firstLine = outcome.detail.split("\n")[0];
      expect(firstLine.slice(0, 160)).toContain('context "prod-eks" (bound by k8s.profiles.prod.context)');
    }
  });

  test("classification survives a duplicated copy of the client package", () => {
    // Discrimination is by `name`, not `instanceof`, so an error from a second
    // physical copy of the package in a consumer's tree still classifies.
    const foreign = Object.assign(new Error("not found"), { name: "K8sApiError", statusCode: 404, reason: "NotFound" });
    expect(classifyApiFailure(foreign)).toEqual({ kind: "absent" });
  });
});

describe("whole-lexicon failures", () => {
  test.each([
    [new KubeConfigError("no cluster"), true],
    [new ExecCredentialNotAllowedError("harvest", ["aws"]), true],
    [new K8sClientUnavailableError(), true],
    [status(404, "NotFound"), false],
    [new K8sTransportError("refused"), false],
  ])("%s", (err, expected) => {
    expect(isWholeLexiconFailure(err)).toBe(expected);
  });
});

describe("missing client package detection", () => {
  test("a module-resolution failure naming either package is recognized", () => {
    for (const spec of ["@intentius/chant-k8s-client", "@kubernetes/client-node"]) {
      const err = Object.assign(new Error(`Cannot find package '${spec}'`), { code: "ERR_MODULE_NOT_FOUND" });
      expect(isMissingClientPackage(err)).toBe(true);
    }
  });

  test("an unrelated module error is not", () => {
    const err = Object.assign(new Error("Cannot find package 'left-pad'"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isMissingClientPackage(err)).toBe(false);
    expect(isMissingClientPackage(new Error("nope"))).toBe(false);
  });

  test("the detail names the install command", () => {
    expect(MISSING_CLIENT_DETAIL).toContain("npm i @intentius/chant-k8s-client");
  });
});
