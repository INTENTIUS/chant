/**
 * WK8506: a top-level key the kind does not declare (#5111).
 */
import { describe, expect, test } from "vitest";
import { dump } from "js-yaml";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { wk8506 } from "./wk8506";
import { getTopLevelFieldsRegistry } from "./top-level-fields-helpers";

const ctx = (...docs: object[]) => makePostSynthCtx("k8s", docs.map((d) => dump(d, { lineWidth: -1 })).join("---\n"));
const hasLexicon = getTopLevelFieldsRegistry().size > 0;

describe("WK8506: top-level key the kind does not declare", () => {
  test("metadata", () => {
    expect(wk8506.id).toBe("WK8506");
  });

  test.skipIf(!hasLexicon)("flags labels written beside metadata, naming the object and the key", () => {
    const diags = wk8506.check(
      ctx({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "dash" }, labels: { grafana_dashboard: "1" }, data: { a: "b" } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WK8506");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("dash");
    expect(diags[0].message).toContain('ConfigMap "dash"');
    expect(diags[0].message).toContain('"labels"');
    expect(diags[0].message).toContain("kubectl apply rejects it");
  });

  test.skipIf(!hasLexicon)("says so when metadata has a field of that name", () => {
    const [diag] = wk8506.check(
      ctx({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "dash", labels: { a: "b" } }, labels: { a: "b" } }),
    );
    expect(diag.message).toContain('metadata has a field named "labels"');
  });

  test.skipIf(!hasLexicon)("does not say so when metadata has no such field", () => {
    const [diag] = wk8506.check(ctx({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "dash" }, labels: { a: "b" } }));
    expect(diag.message).not.toContain("metadata has a field");
  });

  test.skipIf(!hasLexicon)("reports each unknown key of one object", () => {
    const diags = wk8506.check(ctx({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "x" }, labels: {}, annotations: {} }));
    expect(diags.map((d) => /"(\w+)"/.exec(d.message.slice(d.message.indexOf(": ")))![1])).toEqual(["labels", "annotations"]);
  });

  test.skipIf(!hasLexicon)("accepts the fields each kind declares, status included where the schema has it", () => {
    expect(
      wk8506.check(
        ctx(
          { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "a" }, data: {}, binaryData: {}, immutable: true },
          { apiVersion: "v1", kind: "Secret", metadata: { name: "b" }, stringData: {}, type: "Opaque" },
          { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "c" }, spec: {}, status: {} },
          { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: "d" }, rules: [], aggregationRule: {} },
          { apiVersion: "cert-manager.io/v1", kind: "Certificate", metadata: { name: "e" }, spec: {} },
        ),
      ),
    ).toEqual([]);
  });

  test.skipIf(!hasLexicon)("a ConfigMap has no status, so one is flagged", () => {
    expect(wk8506.check(ctx({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "a" }, status: {} }))).toHaveLength(1);
  });

  test.skipIf(!hasLexicon)("flags a stray key on a custom resource the lexicon has a schema for", () => {
    const diags = wk8506.check(
      ctx({ apiVersion: "cert-manager.io/v1", kind: "Certificate", metadata: { name: "e" }, spec: {}, data: {} }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"data"');
  });

  test("leaves a kind the lexicon does not know alone", () => {
    expect(wk8506.check(ctx({ apiVersion: "example.com/v1", kind: "Widget", metadata: { name: "w" }, anything: 1 }))).toEqual([]);
  });

  test("leaves an apiVersion the lexicon does not carry for the kind alone", () => {
    expect(wk8506.check(ctx({ apiVersion: "apps/v1beta1", kind: "Deployment", metadata: { name: "w" }, anything: 1 }))).toEqual([]);
  });
});
