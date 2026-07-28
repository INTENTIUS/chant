/**
 * The conflict surface (chant #1075).
 *
 * The `Status` bodies below are shaped like real API-server output for a
 * refused server-side apply: `details.causes` on a current server, and the
 * prose-only form some aggregated/older servers send instead.
 */

import { describe, test, expect } from "vitest";
import {
  FieldManagerConflictError,
  asFieldManagerConflict,
  parseConflictMessage,
  parseFieldConflicts,
  renderConflictReport,
} from "./conflict";
import { K8sApiError, type K8sStatus } from "./errors";

const CAUSES_STATUS: K8sStatus = {
  kind: "Status",
  apiVersion: "v1",
  status: "Failure",
  reason: "Conflict",
  code: 409,
  message:
    'Apply failed with 2 conflicts: conflicts with "kubectl-client-side-apply" using apps/v1:\n' +
    "- .spec.replicas\n" +
    '- .spec.template.spec.containers[name="web"].image',
  details: {
    causes: [
      {
        type: "FieldManagerConflict",
        message: 'conflict with "kubectl-client-side-apply" using apps/v1',
        field: ".spec.replicas",
      },
      {
        type: "FieldManagerConflict",
        message: 'conflict with "kubectl-client-side-apply" using apps/v1',
        field: '.spec.template.spec.containers[name="web"].image',
      },
    ],
  },
};

function apiError(status: K8sStatus, target = "apps/v1 Deployment prod/web"): K8sApiError {
  return new K8sApiError(409, status.reason, status.message ?? "", target, status);
}

describe("parsing the conflict out of the Status", () => {
  test("details.causes is the machine-readable form and is used when present", () => {
    expect(parseFieldConflicts(CAUSES_STATUS)).toEqual([
      { manager: "kubectl-client-side-apply", field: ".spec.replicas", apiVersion: "apps/v1" },
      {
        manager: "kubectl-client-side-apply",
        field: '.spec.template.spec.containers[name="web"].image',
        apiVersion: "apps/v1",
      },
    ]);
  });

  test("two managers in one refusal are kept apart", () => {
    const conflicts = parseFieldConflicts({
      reason: "Conflict",
      details: {
        causes: [
          { type: "FieldManagerConflict", message: 'conflict with "helm"', field: ".spec.replicas" },
          { type: "FieldManagerConflict", message: 'conflict with "argo"', field: ".metadata.labels.env" },
        ],
      },
    });
    expect(conflicts.map((c) => c.manager)).toEqual(["helm", "argo"]);
  });

  test("a cause of some other type is not read as a field conflict", () => {
    expect(
      parseFieldConflicts({
        reason: "Conflict",
        details: { causes: [{ type: "FieldValueInvalid", message: "bad", field: ".spec.replicas" }] },
      }),
    ).toEqual([]);
  });

  test("the prose form is parsed when the server sent no causes", () => {
    expect(
      parseConflictMessage(
        'Apply failed with 2 conflicts: conflicts with "kubectl" using apps/v1:\n' +
          "- .spec.replicas\n" +
          "- .spec.paused",
      ),
    ).toEqual([
      { manager: "kubectl", field: ".spec.replicas", apiVersion: "apps/v1" },
      { manager: "kubectl", field: ".spec.paused", apiVersion: "apps/v1" },
    ]);
  });

  test("the prose form with several managers attributes each block to its own", () => {
    const conflicts = parseConflictMessage(
      'Apply failed with 2 conflicts: conflicts with "helm":\n' +
        "- .spec.replicas\n" +
        'conflicts with "argocd":\n' +
        "- .metadata.labels.env",
    );
    expect(conflicts).toEqual([
      { manager: "helm", field: ".spec.replicas" },
      { manager: "argocd", field: ".metadata.labels.env" },
    ]);
  });

  test("a single inline conflict is read out of the header line", () => {
    expect(parseConflictMessage('Apply failed with 1 conflict: conflict with "kubectl": .spec.replicas')).toEqual([
      { manager: "kubectl", field: ".spec.replicas" },
    ]);
  });

  test("a message that names nothing parseable yields nothing rather than a guess", () => {
    expect(parseConflictMessage("the object has been modified")).toEqual([]);
    expect(parseFieldConflicts(undefined, "")).toEqual([]);
  });
});

describe("FieldManagerConflictError", () => {
  const error = asFieldManagerConflict(apiError(CAUSES_STATUS), "chant:web") as FieldManagerConflictError;

  test("it is still a K8sApiError, so nothing that caught 409s stops working", () => {
    expect(error).toBeInstanceOf(FieldManagerConflictError);
    expect(error).toBeInstanceOf(K8sApiError);
    expect(error.statusCode).toBe(409);
    expect(error.conflict).toBe(true);
    expect(error.name).toBe("FieldManagerConflictError");
  });

  test("it names the competing manager and the contested paths", () => {
    expect(error.managers).toEqual(["kubectl-client-side-apply"]);
    expect(error.fields).toEqual([
      ".spec.replicas",
      '.spec.template.spec.containers[name="web"].image',
    ]);
    expect(error.byManager).toEqual({
      "kubectl-client-side-apply": [
        ".spec.replicas",
        '.spec.template.spec.containers[name="web"].image',
      ],
    });
  });

  test("it records which manager chant applied as", () => {
    expect(error.fieldManager).toBe("chant:web");
  });

  test("the message names the object, the owner, every field, and the way out", () => {
    const text = error.message;
    expect(text).toContain("apps/v1 Deployment prod/web");
    expect(text).toContain('"kubectl-client-side-apply" owns:');
    expect(text).toContain(".spec.replicas");
    expect(text).toContain('.spec.template.spec.containers[name="web"].image');
    expect(text).toContain('chant applied as field manager "chant:web"');
    expect(text).toContain("chant does not force this for you");
    expect(text).toContain("force-conflicts");
  });

  test("nothing in the rendering recommends forcing — both ways out are stated", () => {
    expect(error.message).toContain("remove the contested fields from your chant source");
    expect(error.message).toContain("deliberately");
  });

  test("a 409 with no parseable causes still says what happened and quotes the server", () => {
    const bare = asFieldManagerConflict(
      apiError({ reason: "Conflict", code: 409, message: "the object has been modified" }),
      "chant",
    ) as FieldManagerConflictError;
    expect(bare.conflicts).toEqual([]);
    expect(bare.message).toContain("the object has been modified");
    expect(bare.message).toContain('field manager "chant"');
  });

  test("singular and plural both read correctly", () => {
    const one = renderConflictReport({
      conflicts: [{ manager: "helm", field: ".spec.replicas" }],
      fieldManager: "chant",
      target: "apps/v1 Deployment prod/web",
    });
    expect(one).toContain("1 field is owned by another field manager");
    const two = renderConflictReport({
      conflicts: [
        { manager: "helm", field: ".spec.replicas" },
        { manager: "helm", field: ".spec.paused" },
      ],
      fieldManager: "chant",
    });
    expect(two).toContain("2 fields are owned by another field manager");
  });
});

describe("asFieldManagerConflict is a narrowing, not a catch-all", () => {
  test("a non-409 API error passes through untouched", () => {
    const notFound = new K8sApiError(404, "NotFound", "not found", "apps/v1 Deployment prod/web");
    expect(asFieldManagerConflict(notFound, "chant")).toBe(notFound);
  });

  test("something that is not an API error at all passes through untouched", () => {
    const boom = new Error("socket hang up");
    expect(asFieldManagerConflict(boom, "chant")).toBe(boom);
  });

  test("an already-presented conflict is not re-wrapped", () => {
    const once = asFieldManagerConflict(apiError(CAUSES_STATUS), "chant:web");
    expect(asFieldManagerConflict(once, "chant:web")).toBe(once);
  });
});
