/**
 * DKRD003: SSH Port Exposed
 *
 * Detects services exposing port 22 (SSH) on the host.
 * Exposing SSH externally is a security risk.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractServices } from "./docker-helpers";

function exposesSshPort(port: string): boolean {
  // Formats: "22", "22/tcp", "0.0.0.0:22:22", "127.0.0.1:22:22", "host:container"
  const normalized = port.trim();
  const parts = normalized.split(":");

  if (parts.length === 1) {
    // Just a port number: "22" or "22/tcp"
    const portNum = parts[0].split("/")[0];
    return portNum === "22";
  }

  if (parts.length === 2) {
    // "hostPort:containerPort" e.g. "22:22" — no IP binding, accessible on all interfaces
    const hostPort = parts[0].split("/")[0];
    return hostPort === "22";
  }

  if (parts.length >= 3) {
    // "ip:hostPort:containerPort" e.g. "127.0.0.1:22:22" or "0.0.0.0:22:22"
    const ip = parts[0];
    const hostPort = parts[1].split("/")[0];
    // Only flag if port is 22 AND not bound to loopback
    if (hostPort !== "22") return false;
    return ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost";
  }

  return false;
}

export const dkrd003: PostSynthCheck = {
  id: "DKRD003",
  description: "Service exposes SSH port (22) externally — this is a security risk",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_outputName, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      if (!yaml) continue;

      const services = extractServices(yaml);
      for (const [name, svc] of services) {
        for (const port of svc.ports ?? []) {
          if (exposesSshPort(port)) {
            diagnostics.push({
              checkId: "DKRD003",
              severity: "error",
              message: `Service "${name}" exposes SSH port 22 externally (port mapping: "${port}"). This is a security risk.`,
              lexicon: "docker",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
