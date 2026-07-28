/**
 * Decoding `metadata.managedFields` (chant #1075, for #1076).
 *
 * The fixtures below are shaped like real API-server output, including the
 * cases that make the encoding awkward: a list addressed by key, a set
 * addressed by value, the `.` marker for "the element itself", and a `status`
 * subresource entry written by a controller that chant must not mistake for a
 * competitor over the spec.
 */

import { describe, test, expect } from "vitest";
import {
  chantOwnedFields,
  fieldOwners,
  fieldPathsOf,
  fieldSetsOf,
  fieldsOwnedBy,
  managedFieldsOf,
  managersOf,
  renderSegment,
} from "./managed-fields";
import type { K8sObject } from "./types";

const deployment: K8sObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "web",
    namespace: "prod",
    managedFields: [
      {
        manager: "chant:web",
        operation: "Apply",
        apiVersion: "apps/v1",
        fieldsType: "FieldsV1",
        time: "2026-07-20T10:00:00Z",
        fieldsV1: {
          "f:metadata": { "f:labels": { "f:app": {} } },
          "f:spec": {
            "f:replicas": {},
            "f:template": {
              "f:spec": {
                "f:containers": {
                  'k:{"name":"web"}': { ".": {}, "f:image": {}, "f:name": {} },
                },
              },
            },
          },
        },
      },
      {
        manager: "kubectl-client-side-apply",
        operation: "Update",
        apiVersion: "apps/v1",
        fieldsType: "FieldsV1",
        fieldsV1: { "f:spec": { "f:replicas": {} } },
      },
      {
        manager: "kube-controller-manager",
        operation: "Update",
        apiVersion: "apps/v1",
        subresource: "status",
        fieldsType: "FieldsV1",
        fieldsV1: { "f:status": { "f:readyReplicas": {} } },
      },
    ],
  },
};

describe("fieldPathsOf — the fieldsV1 encoding", () => {
  test("nested fields become dotted paths, parents included", () => {
    expect(fieldPathsOf({ "f:spec": { "f:replicas": {} } })).toEqual([".spec", ".spec.replicas"]);
  });

  test("a keyed list item renders the way the API server writes conflicts", () => {
    const paths = fieldPathsOf({
      "f:spec": { "f:containers": { 'k:{"name":"web"}': { ".": {}, "f:image": {} } } },
    });
    expect(paths).toContain('.spec.containers[name="web"]');
    expect(paths).toContain('.spec.containers[name="web"].image');
  });

  test("a multi-key list item keeps the declared key order and JSON value forms", () => {
    expect(fieldPathsOf({ "f:ports": { 'k:{"port":80,"protocol":"TCP"}': {} } })).toEqual([
      ".ports",
      '.ports[port=80,protocol="TCP"]',
    ]);
  });

  test("set items by value and list items by index", () => {
    expect(renderSegment('v:"blue"')).toBe('[="blue"]');
    expect(renderSegment("i:3")).toBe("[3]");
  });

  test('"." marks the containing element, and adds no segment of its own', () => {
    // Nothing but a "." at the root owns no path — there is no element above it.
    expect(fieldPathsOf({ ".": {} })).toEqual([]);
    expect(fieldPathsOf({ "f:a": { ".": {} } })).toEqual([".a"]);
  });

  test("an unrecognised prefix is skipped rather than mangled into a wrong path", () => {
    expect(renderSegment("q:something")).toBeUndefined();
    expect(fieldPathsOf({ "q:future": { "f:inner": {} } })).toEqual([]);
  });

  test("a key that is not decodable JSON is kept verbatim", () => {
    expect(renderSegment("k:{not json}")).toBe("[{not json}]");
  });

  test("no managedFields at all is an empty answer, not a throw", () => {
    expect(fieldPathsOf(undefined)).toEqual([]);
    expect(managedFieldsOf(undefined)).toEqual([]);
    expect(managedFieldsOf({ metadata: {} })).toEqual([]);
    expect(fieldSetsOf({})).toEqual([]);
  });
});

describe("per-manager field sets", () => {
  test("every entry is decoded, and entries are kept separate rather than merged", () => {
    const sets = fieldSetsOf(deployment);
    expect(sets.map((s) => s.manager)).toEqual([
      "chant:web",
      "kubectl-client-side-apply",
      "kube-controller-manager",
    ]);
    expect(sets[0].operation).toBe("Apply");
    expect(sets[0].time).toBe("2026-07-20T10:00:00Z");
    expect(sets[2].subresource).toBe("status");
  });

  test("chant's own fields are exactly what the manifest declared", () => {
    expect(chantOwnedFields(deployment)).toEqual([
      ".metadata",
      ".metadata.labels",
      ".metadata.labels.app",
      ".spec",
      ".spec.replicas",
      ".spec.template",
      ".spec.template.spec",
      ".spec.template.spec.containers",
      '.spec.template.spec.containers[name="web"]',
      '.spec.template.spec.containers[name="web"].image',
      '.spec.template.spec.containers[name="web"].name',
    ]);
  });

  test("a status subresource entry is excluded unless asked for", () => {
    expect(fieldsOwnedBy(deployment, "kube-controller-manager")).toEqual([]);
    expect(fieldsOwnedBy(deployment, "kube-controller-manager", { includeSubresources: true })).toEqual([
      ".status",
      ".status.readyReplicas",
    ]);
  });

  test("chant is found by any qualified name, since a stack rename changes it", () => {
    const renamed: K8sObject = {
      metadata: {
        managedFields: [
          { manager: "chant:old", operation: "Apply", fieldsV1: { "f:spec": { "f:replicas": {} } } },
          { manager: "chant", operation: "Apply", fieldsV1: { "f:spec": { "f:paused": {} } } },
        ],
      },
    };
    expect(chantOwnedFields(renamed)).toEqual([".spec", ".spec.paused", ".spec.replicas"]);
  });

  test("managersOf lists every manager once, in order", () => {
    expect(managersOf(deployment)).toEqual([
      "chant:web",
      "kubectl-client-side-apply",
      "kube-controller-manager",
    ]);
  });
});

describe("fieldOwners — who holds what", () => {
  test("a contested path names both holders", () => {
    const owners = fieldOwners(deployment);
    expect(owners.get(".spec.replicas")).toEqual(["chant:web", "kubectl-client-side-apply"]);
  });

  test("an uncontested path names one", () => {
    const owners = fieldOwners(deployment);
    expect(owners.get('.spec.template.spec.containers[name="web"].image')).toEqual(["chant:web"]);
  });

  test("subresource entries stay out of the map by default", () => {
    expect(fieldOwners(deployment).has(".status.readyReplicas")).toBe(false);
    expect(fieldOwners(deployment, { includeSubresources: true }).get(".status.readyReplicas")).toEqual([
      "kube-controller-manager",
    ]);
  });

  test("an entry with no manager name is ignored rather than counted as anonymous", () => {
    const odd: K8sObject = { metadata: { managedFields: [{ fieldsV1: { "f:spec": {} } }, null as never] } };
    expect(fieldSetsOf(odd)).toEqual([]);
    expect(managersOf(odd)).toEqual([]);
  });
});
