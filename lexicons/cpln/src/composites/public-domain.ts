/**
 * PublicDomain — a custom domain routed to workloads in one GVC.
 *
 * Domains carry several rules that are easy to violate by picking the
 * combination that reads best rather than the one that works:
 *
 * - An **apex domain must use `cname` mode**. NS mode does not support apex,
 *   and there is no partial-credit failure — the domain simply will not
 *   validate.
 * - **NS mode requires the `dns01` certificate challenge**; `http01` is
 *   rejected outright.
 * - `gvcLink`, `workloadLink` and `ports[].routes` are **mutually exclusive**
 *   ways of saying where traffic goes; exactly one may be set.
 * - Every route in a domain must target workloads in the **same GVC**.
 *
 * This composite takes a GVC and a route table, derives the mode when it can,
 * and refuses the combinations above at build time.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Domain } from "../generated";

export interface DomainRoute {
  /** Path prefix to match (e.g. `/api`). One of `prefix` or `regex`. */
  prefix?: string;
  /** RE2 path regex to match. One of `prefix` or `regex`. */
  regex?: string;
  /** Name of the workload in `gvc` to route to. */
  workload: string;
  /** Port on the workload (default 8080). */
  port?: number;
  /** Rewrite the matched prefix to this before forwarding. */
  replacePrefix?: string;
}

export interface PublicDomainProps {
  /** The domain name, e.g. `api.example.com` or the apex `example.com`. */
  name: string;
  /** The GVC every route targets. */
  gvc: string;
  /**
   * Routes for the domain. Omit to send all traffic to the GVC's default
   * routing (a `gvcLink` domain) instead.
   */
  routes?: DomainRoute[];
  /**
   * DNS mode. Defaults to `cname`, which is also the only mode valid for an
   * apex domain.
   */
  dnsMode?: "cname" | "ns";
  /**
   * Certificate challenge type. Defaults to `dns01` under `ns` (the only
   * option there) and `http01` under `cname`.
   */
  certChallengeType?: "dns01" | "http01";
  /** Public port (default 443). */
  port?: number;
  /** Protocol (default `http2`). `tcp` requires a dedicated load balancer. */
  protocol?: "http" | "http2" | "tcp";
  /** Tags applied to the domain. */
  tags?: Record<string, string>;
  /** Per-member defaults for customizing the underlying resource. */
  defaults?: {
    domain?: Partial<ConstructorParameters<typeof Domain>[0]>;
  };
}

/** An apex domain has exactly one dot: `example.com`, not `api.example.com`. */
export function isApexDomain(name: string): boolean {
  return name.split(".").filter(Boolean).length === 2;
}

export const PublicDomain = Composite((props: PublicDomainProps) => {
  const {
    name,
    gvc,
    routes,
    dnsMode = "cname",
    certChallengeType = dnsMode === "ns" ? "dns01" : "http01",
    port = 443,
    protocol = "http2",
    tags,
    defaults: defs,
  } = props;

  if (dnsMode === "ns" && isApexDomain(name)) {
    throw new Error(
      `PublicDomain "${name}": an apex domain must use dnsMode "cname". NS mode does not support apex domains.`,
    );
  }

  if (dnsMode === "ns" && certChallengeType !== "dns01") {
    throw new Error(
      `PublicDomain "${name}": dnsMode "ns" requires certChallengeType "dns01"; "${certChallengeType}" is rejected.`,
    );
  }

  for (const route of routes ?? []) {
    if (!route.prefix && !route.regex) {
      throw new Error(`PublicDomain "${name}": every route needs a \`prefix\` or a \`regex\`.`);
    }
    if (route.prefix && route.regex) {
      throw new Error(
        `PublicDomain "${name}": route for workload "${route.workload}" sets both \`prefix\` and \`regex\`; ` +
          `only one may be provided.`,
      );
    }
  }

  const domain = new Domain(
    mergeDefaults(
      {
        name,
        ...(tags && { tags }),
        spec: {
          dnsMode,
          certChallengeType,
          // `gvcLink` and `ports[].routes` are mutually exclusive: a domain
          // with explicit routes must not also carry a GVC link.
          ...(routes && routes.length > 0
            ? {
                ports: [
                  {
                    number: port,
                    protocol,
                    routes: routes.map((route) => ({
                      ...(route.prefix && { prefix: route.prefix }),
                      ...(route.regex && { regex: route.regex }),
                      ...(route.replacePrefix && { replacePrefix: route.replacePrefix }),
                      port: route.port ?? 8080,
                      workloadLink: `//gvc/${gvc}/workload/${route.workload}`,
                    })),
                  },
                ],
              }
            : { gvcLink: `//gvc/${gvc}` }),
        },
      } as Record<string, unknown>,
      defs?.domain,
    ),
  );

  return { domain };
}, "PublicDomain");
