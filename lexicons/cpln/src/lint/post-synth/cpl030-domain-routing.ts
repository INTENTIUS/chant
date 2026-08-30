import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readPath, readString } from "../../entity-props";
import { DOMAIN, GVC, WORKLOAD, entitiesOfType, parseLink } from "./helpers";

/** An apex domain has exactly two labels: `example.com`, not `api.example.com`. */
function isApex(name: string): boolean {
  return name.split(".").filter(Boolean).length === 2;
}

export const domainRoutingCheck: PostSynthCheck = {
  id: "CPL030",
  description: "Domain DNS mode, certificate challenge, and routing target must be a valid combination",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    // Workload types, so a `workloadLink` route can be checked for the stateful
    // requirement that replica-direct routing carries.
    const workloadTypes = new Map<string, string>();
    for (const [entityName, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      workloadTypes.set(readString(entity, "name") ?? entityName, readString(entity, "spec", "type") ?? "serverless");
    }

    for (const [entityName, entity] of entitiesOfType(ctx.entities, DOMAIN)) {
      const name = readString(entity, "name") ?? entityName;
      const dnsMode = readString(entity, "spec", "dnsMode") ?? "cname";
      const challenge = readString(entity, "spec", "certChallengeType");
      const gvcLink = readString(entity, "spec", "gvcLink");
      const workloadLink = readString(entity, "spec", "workloadLink");
      const ports = readArray(entity, "spec", "ports");
      const routed = ports.some((port) => readArray(port, "routes").length > 0);

      if (dnsMode === "ns" && isApex(name)) {
        diagnostics.push({
          checkId: "CPL030",
          severity: "error",
          message:
            `Domain "${name}" is an apex domain with dnsMode "ns". NS mode does not support apex domains — ` +
            `use "cname".`,
          entity: entityName,
          lexicon: "cpln",
        });
      }

      if (dnsMode === "ns" && challenge === "http01") {
        diagnostics.push({
          checkId: "CPL030",
          severity: "error",
          message:
            `Domain "${name}" uses dnsMode "ns" with certChallengeType "http01", which is rejected. ` +
            `NS mode requires "dns01".`,
          entity: entityName,
          lexicon: "cpln",
        });
      }

      const targets = [gvcLink && "gvcLink", workloadLink && "workloadLink", routed && "ports[].routes"].filter(
        Boolean,
      ) as string[];

      if (targets.length > 1) {
        diagnostics.push({
          checkId: "CPL030",
          severity: "error",
          message:
            `Domain "${name}" sets ${targets.join(" and ")}. These are mutually exclusive ways of saying ` +
            `where traffic goes — keep exactly one.`,
          entity: entityName,
          lexicon: "cpln",
        });
      }

      if (targets.length === 0) {
        diagnostics.push({
          checkId: "CPL030",
          severity: "warning",
          message:
            `Domain "${name}" names no routing target. Set one of gvcLink, workloadLink, or ports[].routes, ` +
            `or the domain resolves to nothing.`,
          entity: entityName,
          lexicon: "cpln",
        });
      }

      // `workloadLink` is replica-direct routing, which only stateful supports.
      if (workloadLink) {
        const link = parseLink(workloadLink);
        const type = link && workloadTypes.get(link.name);
        if (type && type !== "stateful") {
          diagnostics.push({
            checkId: "CPL030",
            severity: "error",
            message:
              `Domain "${name}" routes via workloadLink to "${link!.name}", which is type "${type}". ` +
              `workloadLink is replica-direct routing and is supported on stateful workloads only.`,
            entity: entityName,
            lexicon: "cpln",
          });
        }
      }

      // Every route in a domain must target workloads in one GVC.
      const routeGvcs = new Set<string>();
      for (const port of ports) {
        for (const route of readArray(port, "routes")) {
          const target = readString(route, "workloadLink");
          const link = target ? parseLink(target) : undefined;
          if (link?.gvc) routeGvcs.add(link.gvc);
        }
      }

      if (routeGvcs.size > 1) {
        diagnostics.push({
          checkId: "CPL030",
          severity: "error",
          message:
            `Domain "${name}" routes to workloads in ${routeGvcs.size} GVCs (${[...routeGvcs].sort().join(", ")}). ` +
            `All routes in a domain must target workloads in the same GVC.`,
          entity: entityName,
          lexicon: "cpln",
        });
      }

      if (readPath(entity, "spec", "acceptAllHosts") === true && readPath(entity, "spec", "acceptAllSubdomains") === true) {
        diagnostics.push({
          checkId: "CPL030",
          severity: "error",
          message: `Domain "${name}" sets both acceptAllHosts and acceptAllSubdomains; they are mutually exclusive.`,
          entity: entityName,
          lexicon: "cpln",
        });
      }
    }

    return diagnostics;
  },
};
