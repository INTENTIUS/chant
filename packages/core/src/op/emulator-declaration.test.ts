/**
 * A plugin declares one emulator or several (#1345), and the vars that point
 * tooling at a running one are read off that declaration rather than a map in
 * core.
 */

import { describe, test, expect } from "vitest";
import { emulatorsOf, endpointEnvVars, type EmulatorCapability } from "./emulator-lifecycle";

const capability = (name: string, env: (endpoint: string) => Record<string, string>): EmulatorCapability => ({
  spec: { name, image: `${name}:1.0.0`, containerPort: 1, healthPath: "/h" },
  env,
});

const aws = capability("chant-floci", (endpoint) => ({
  AWS_ENDPOINT_URL: endpoint,
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AWS_REGION: "us-east-1",
}));
const mudflaps = capability("chant-mudflaps", (endpoint) => ({ FLY_FLAPS_BASE_URL: endpoint }));
const spritzer = capability("chant-spritzer", (endpoint) => ({ SPRITES_BASE_URL: endpoint }));

describe("emulatorsOf", () => {
  test("a single capability is a list of one", () => {
    expect(emulatorsOf(aws)).toEqual([aws]);
  });

  test("a list passes through — fly ships two", () => {
    expect(emulatorsOf([mudflaps, spritzer])).toEqual([mudflaps, spritzer]);
  });

  test("no declaration is an empty list, not a crash", () => {
    expect(emulatorsOf(undefined)).toEqual([]);
  });

  test("an empty list is respected", () => {
    expect(emulatorsOf([])).toEqual([]);
  });
});

describe("endpointEnvVars", () => {
  test("keeps only the vars whose value is the endpoint", () => {
    // The credentials and region an emulator also needs are not endpoint vars;
    // injecting them into a `--live` read's ambient shell is a different job.
    expect(endpointEnvVars(aws)).toEqual(["AWS_ENDPOINT_URL"]);
  });

  test("an emulator reached only by an explicit argument declares none", () => {
    // gcp: `gcpApply` takes an `endpoint` argument, so there is no var to set.
    expect(endpointEnvVars(capability("chant-floci-gcp", () => ({})))).toEqual([]);
  });

  test("more than one var can carry the endpoint", () => {
    const both = capability("x", (endpoint) => ({ A_URL: endpoint, B_URL: endpoint, TOKEN: "t" }));
    expect(endpointEnvVars(both)).toEqual(["A_URL", "B_URL"]);
  });

  test("a var whose value merely contains the endpoint is not one", () => {
    const wrapped = capability("x", (endpoint) => ({ CONN: `url=${endpoint};ssl=true` }));
    expect(endpointEnvVars(wrapped)).toEqual([]);
  });
});
