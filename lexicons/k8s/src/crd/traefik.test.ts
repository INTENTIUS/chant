/**
 * Traefik acceptance test.
 *
 * Transcribed from fountain's `k8s/ingressroute.yaml` — the websecure route
 * with `tls.secretName`, and the web route whose middleware lives in another
 * namespace. The cross-namespace reference is the reason this file exists: it
 * is one extra key, it is easy to leave off, and leaving it off produces a
 * route that applies cleanly and drops traffic.
 */

import { describe, test, expect } from "vitest";
import { IngressRoute, Middleware } from "../generated";
import { k8sSerializer } from "../serializer";
import { parseYAML } from "@intentius/chant/yaml";

function synth(logicalName: string, resource: unknown): any {
  const yaml = k8sSerializer.serialize(new Map([[logicalName, resource as never]]));
  return parseYAML(yaml);
}

describe("Traefik IngressRoute", () => {
  const secure = new IngressRoute({
    metadata: { name: "fountain", namespace: "fountain", labels: { app: "fountain" } },
    spec: {
      entryPoints: ["websecure"],
      routes: [
        {
          match: "Host(`fountain.inevitable.fyi`)",
          kind: "Rule",
          services: [{ name: "fountain", port: 80 }],
        },
      ],
      tls: { secretName: "fountain-tls" },
    },
  });

  const plain = new IngressRoute({
    metadata: { name: "fountain-http", namespace: "fountain", labels: { app: "fountain" } },
    spec: {
      entryPoints: ["web"],
      routes: [
        {
          match: "Host(`fountain.inevitable.fyi`)",
          kind: "Rule",
          middlewares: [{ name: "redirect-https", namespace: "default" }],
          services: [{ name: "fountain", port: 80 }],
        },
      ],
    },
  });

  test("carries the Traefik apiVersion and kind", () => {
    const doc = synth("fountain", secure);
    expect(doc.apiVersion).toBe("traefik.io/v1alpha1");
    expect(doc.kind).toBe("IngressRoute");
  });

  test("reproduces the websecure route", () => {
    const { spec } = synth("fountain", secure);
    expect(spec.entryPoints).toEqual(["websecure"]);
    expect(spec.tls).toEqual({ secretName: "fountain-tls" });
    expect(spec.routes).toHaveLength(1);
    expect(spec.routes[0].kind).toBe("Rule");
    expect(spec.routes[0].services).toEqual([{ name: "fountain", port: 80 }]);
  });

  test("preserves the matcher grammar verbatim", () => {
    const { spec } = synth("fountain", secure);
    // Traefik's matcher is its own language, and the backticks around the host
    // are part of it -- not YAML quoting. Anything that strips or re-quotes
    // them produces a rule that parses and matches nothing.
    expect(spec.routes[0].match).toBe("Host(`fountain.inevitable.fyi`)");
    expect(spec.routes[0].match).toContain("`fountain.inevitable.fyi`");
  });

  test("keeps the namespace on a cross-namespace middleware ref", () => {
    const { spec } = synth("fountainHttp", plain);
    // `redirect-https` lives in `default`, the route in `fountain`. Without the
    // qualifier Traefik looks in the route's own namespace, finds nothing, and
    // serves the route with no redirect -- so plain HTTP quietly keeps working
    // instead of upgrading.
    expect(spec.routes[0].middlewares).toEqual([
      { name: "redirect-https", namespace: "default" },
    ]);
  });

  test("a route with no TLS omits the key rather than emptying it", () => {
    const { spec } = synth("fountainHttp", plain);
    expect(spec.tls).toBeUndefined();
    expect(spec.entryPoints).toEqual(["web"]);
  });
});

describe("Traefik Middleware", () => {
  test("serializes the redirect the routes point at", () => {
    const doc = synth(
      "redirectHttps",
      new Middleware({
        metadata: { name: "redirect-https", namespace: "default" },
        spec: { redirectScheme: { scheme: "https", permanent: true } },
      }),
    );
    expect(doc.apiVersion).toBe("traefik.io/v1alpha1");
    expect(doc.kind).toBe("Middleware");
    expect(doc.metadata.namespace).toBe("default");
    expect(doc.spec.redirectScheme).toEqual({ scheme: "https", permanent: true });
  });
});
