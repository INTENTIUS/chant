/**
 * Config Connector YAML has no outputs, so an output of a gcp resource is
 * named in a warning instead of vanishing (#4181).
 */

import { describe, expect, it } from "vitest";
import { output, CloudRunService } from "./index";
import { gcpSerializer } from "./serializer";

describe("gcp outputs", () => {
  it("warns that an output of a gcp resource can't be written", () => {
    const svc = new CloudRunService({ location: "us-central1", projectRef: { external: "p" }, template: {} }) as any;
    const out = output(svc.status_uri, "WebUri");
    out._setSourceEntity("web");
    const result = gcpSerializer.serialize(new Map([["web", svc]]), [out]);
    expect(typeof result).toBe("object");
    const warnings = (result as { warnings?: string[] }).warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('output "WebUri" (web.status.uri)');
  });

  it("says nothing about an output with no source lexicon", () => {
    const result = gcpSerializer.serialize(new Map(), [output("eastus", "Region")]);
    expect(typeof result).toBe("string");
  });
});
