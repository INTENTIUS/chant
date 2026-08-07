import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readNumber, readString } from "../../entity-props";
import { WORKLOAD, entitiesOfType } from "./helpers";

/**
 * CPL022: `port` and `ports` are mutually exclusive, and port numbers must be
 * unique across every container in a workload.
 *
 * The duplicate case is the one worth catching: two containers each binding
 * 8080 is accepted at author time, rejected at apply, and reads as correct.
 */
export const containerPortsCheck: PostSynthCheck = {
  id: "CPL022",
  description: "Container ports must not mix `port` and `ports`, and must be unique across containers",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      const seen = new Map<number, string>();

      for (const container of readArray(entity, "spec", "containers")) {
        const containerName = readString(container, "name") ?? "?";
        const single = readNumber(container, "port");
        const list = readArray(container, "ports");

        if (single !== undefined && list.length > 0) {
          diagnostics.push({
            checkId: "CPL022",
            severity: "error",
            message:
              `Workload "${name}" container "${containerName}" sets both \`port\` and \`ports\`. ` +
              `They are mutually exclusive — keep \`ports\`.`,
            entity: name,
            lexicon: "cpln",
          });
        }

        const numbers = [
          ...(single !== undefined ? [single] : []),
          ...list.map((port) => readNumber(port, "number")).filter((n): n is number => n !== undefined),
        ];

        for (const number of numbers) {
          const owner = seen.get(number);
          if (owner !== undefined && owner !== containerName) {
            diagnostics.push({
              checkId: "CPL022",
              severity: "error",
              message:
                `Workload "${name}" exposes port ${number} from both "${owner}" and "${containerName}". ` +
                `Port numbers must be unique across the containers of one workload.`,
              entity: name,
              lexicon: "cpln",
            });
          }
          seen.set(number, containerName);
        }
      }
    }

    return diagnostics;
  },
};
