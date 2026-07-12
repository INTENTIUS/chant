import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MACHINES_CONTRACT, normalizeEndpoint, contractKeys } from "./machines-contract";

describe("MACHINES_CONTRACT", () => {
  test("covers the flyApply resource operations (apps, machines, leases, volumes, ips, certs, secrets)", () => {
    for (const area of ["/machines", "/lease", "/volumes", "/ip_assignments", "/certificates", "/secrets"]) {
      expect(MACHINES_CONTRACT.some((e) => e.path.includes(area)), area).toBe(true);
    }
    expect(MACHINES_CONTRACT.some((e) => e.path === "/v1/apps"), "apps").toBe(true);
  });

  test("every entry has a v1/apps path and a known method", () => {
    for (const e of MACHINES_CONTRACT) {
      expect(e.path.startsWith("/v1/apps")).toBe(true);
      expect(["GET", "POST", "PUT", "DELETE"]).toContain(e.method);
    }
  });

  test("normalizeEndpoint collapses param names ({id} ≡ {vol} ≡ {hostname})", () => {
    expect(normalizeEndpoint("DELETE", "/v1/apps/{app}/volumes/{id}")).toBe(
      normalizeEndpoint("DELETE", "/v1/apps/{app}/volumes/{vol}"),
    );
    expect(normalizeEndpoint("GET", "/v1/apps/{app}")).toBe("GET /v1/apps/{}");
  });

  test("contractKeys is the deduped normalized set", () => {
    const keys = contractKeys();
    expect(keys.has("POST /v1/apps")).toBe(true);
    expect(keys.has("DELETE /v1/apps/{}/machines/{}")).toBe(true);
    // lease acquire (POST) and release (DELETE) are distinct keys
    expect(keys.has("POST /v1/apps/{}/machines/{}/lease")).toBe(true);
    expect(keys.has("DELETE /v1/apps/{}/machines/{}/lease")).toBe(true);
  });

  test("every contract path segment appears in the fly-apply.ts source (drift anchor)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fly-apply.ts"), "utf-8");
    const segments = new Set(
      MACHINES_CONTRACT.flatMap((e) =>
        e.path.split("/").filter((s) => s.length > 0 && !s.startsWith("{")),
      ),
    );
    for (const seg of segments) {
      expect(src, `path segment "${seg}" from the contract is absent from fly-apply.ts`).toContain(seg);
    }
  });
});
