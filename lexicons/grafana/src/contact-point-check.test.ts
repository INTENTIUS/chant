import { describe, expect, test } from "vitest";
import { checkContactPointSettings } from "./contact-point-check";
import { CONTACT_POINT_NOTIFIERS } from "./contact-point-settings.gen";
import { CONTACT_POINT_SECRET_SETTINGS } from "./contact-point-secrets";
import { checkAlertingIdentity } from "./validate-alerting";

describe("checkContactPointSettings", () => {
  test("a Slack setting spelled wrong names the right one", () => {
    const [p] = checkContactPointSettings("slack", { recepient: "#ops", url: "$__env{SLACK}" });
    expect(p).toMatchObject({ severity: "warning", path: "recepient" });
    expect(p.message).toContain("did you mean recipient");
  });

  test("a PagerDuty key in the wrong case is matched", () => {
    const problems = checkContactPointSettings("pagerduty", { integrationkey: "$__env{PD}" });
    expect(problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("did you mean integrationKey"), "integrationKey is required"]),
    );
  });

  test("required settings are errors, conditional ones are not", () => {
    expect(checkContactPointSettings("email", {})).toEqual([{ severity: "error", path: "addresses", message: "addresses is required" }]);
    expect(checkContactPointSettings("slack", {})).toEqual([]);
  });

  test("nested objects are checked", () => {
    const problems = checkContactPointSettings("webhook", { url: "http://x", tlsConfig: { insecureSkipVerify: true, nope: 1 } });
    expect(problems.map((p) => p.path)).toEqual(["tlsConfig.nope"]);
  });

  test("an integration without a table is not checked", () => {
    expect(checkContactPointSettings("my-plugin", { anything: 1 })).toEqual([]);
  });
});

describe("GRAF114 contact point settings", () => {
  const doc = (receiver: Record<string, unknown>) => ({
    json: { apiVersion: 1, contactPoints: [{ orgId: 1, name: "cp", receivers: [{ uid: "r1", ...receiver }] }] },
  });

  test("reports an unknown key and a missing required one", () => {
    const issues = checkAlertingIdentity([doc({ type: "email", settings: { adresses: "a@b.c" } })]);
    expect(issues.map((i) => [i.severity, i.message])).toEqual([
      ["warning", expect.stringContaining("did you mean addresses")],
      ["error", expect.stringContaining("addresses is required")],
    ]);
  });

  test("a correct receiver and an unknown integration stay clean", () => {
    expect(checkAlertingIdentity([doc({ type: "email", settings: { addresses: "a@b.c" } })])).toEqual([]);
    expect(checkAlertingIdentity([doc({ type: "custom-plugin", settings: { x: 1 } })])).toEqual([]);
  });
});

describe("secret settings come from the same table", () => {
  test("every integration has an entry", () => {
    expect(Object.keys(CONTACT_POINT_SECRET_SETTINGS).sort()).toEqual(Object.keys(CONTACT_POINT_NOTIFIERS).sort());
  });

  test("nested secrets are dotted paths", () => {
    expect(CONTACT_POINT_SECRET_SETTINGS.pagerduty).toEqual(["integrationKey"]);
    expect(CONTACT_POINT_SECRET_SETTINGS.webhook).toContain("tlsConfig.clientKey");
    expect(CONTACT_POINT_SECRET_SETTINGS.sns).toEqual(["sigv4.access_key", "sigv4.secret_key"]);
  });
});
