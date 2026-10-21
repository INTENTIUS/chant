/**
 * A Container App's hostname is referenceable (#4179), so DNS in another
 * lexicon can point at it: `configuration.ingress.fqdn` is read through
 * `configuration_ingress_fqdn`.
 */

import { describe, expect, test } from "vitest";
import { AttrRef } from "@intentius/chant";
import { containerApps } from "./index";

describe("Container App attributes", () => {
  test("configuration.ingress.fqdn and latestRevisionFqdn are AttrRefs", () => {
    const app = new containerApps({ name: "web", location: "eastus" } as never) as unknown as Record<string, unknown>;
    expect((app.configuration_ingress_fqdn as AttrRef).attribute).toBe("configuration.ingress.fqdn");
    expect(app.latestRevisionFqdn).toBeInstanceOf(AttrRef);
  });
});
