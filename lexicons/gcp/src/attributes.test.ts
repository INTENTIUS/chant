/**
 * A RunService's URL is referenceable (#4179), so DNS in another lexicon can
 * point at it: `status.uri` is read through `status_uri`.
 */

import { describe, expect, test } from "vitest";
import { AttrRef } from "@intentius/chant";
import { CloudRunService } from "./index";

describe("status attributes", () => {
  test("a RunService exposes status.uri as an AttrRef", () => {
    const svc = new CloudRunService({ location: "us-central1", projectRef: { external: "p" }, template: {} }) as unknown as Record<string, unknown>;
    expect(svc.status_uri).toBeInstanceOf(AttrRef);
    expect((svc.status_uri as AttrRef).attribute).toBe("status.uri");
  });
});
