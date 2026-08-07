import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readNumber, readString } from "../../entity-props";
import { GVC, VOLUMESET, WORKLOAD, entitiesOfType } from "./helpers";

/** Minimum initial capacity in GB, by performance class. */
const MIN_CAPACITY_GB: Record<string, number> = {
  "general-purpose-ssd": 10,
  "high-throughput-ssd": 200,
  shared: 10,
};

const MAX_CAPACITY_GB = 65_536;

/** Filesystems that bind to exactly one stateful workload. */
const EXCLUSIVE_FILESYSTEMS = new Set(["ext4", "xfs"]);

/** Control Plane caps a workload at 15 volumes. */
const MAX_VOLUMES = 15;

const VOLUMESET_URI = /^cpln:\/\/volumeset\/(.+)$/;

export const volumeSetCheck: PostSynthCheck = {
  id: "CPL028",
  description: "Volume set capacity, filesystem binding, and workload mount rules",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    // Volume sets by their declared name, so a mount can be checked against the
    // set it names rather than only against itself.
    const volumeSets = new Map<string, { entity: unknown; gvc?: string; fileSystemType: string }>();

    for (const [name, entity] of entitiesOfType(ctx.entities, VOLUMESET)) {
      const declaredName = readString(entity, "name") ?? name;
      const fileSystemType = readString(entity, "spec", "fileSystemType") ?? "ext4";
      volumeSets.set(declaredName, { entity, gvc: readString(entity, "gvc"), fileSystemType });

      const performanceClass =
        readString(entity, "spec", "performanceClass") ?? (fileSystemType === "shared" ? "shared" : "general-purpose-ssd");
      const capacity = readNumber(entity, "spec", "initialCapacity");

      const floor = MIN_CAPACITY_GB[performanceClass];
      if (capacity !== undefined && floor !== undefined && capacity < floor) {
        diagnostics.push({
          checkId: "CPL028",
          severity: "error",
          message:
            `Volume set "${name}" requests ${capacity} GB with performanceClass "${performanceClass}", ` +
            `below its ${floor} GB minimum. performanceClass is immutable after creation, so correcting ` +
            `this later means recreating the volume set and losing its data.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      if (capacity !== undefined && capacity > MAX_CAPACITY_GB) {
        diagnostics.push({
          checkId: "CPL028",
          severity: "error",
          message: `Volume set "${name}" requests ${capacity} GB, above the ${MAX_CAPACITY_GB} GB maximum.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      if (fileSystemType === "shared" && performanceClass !== "shared") {
        diagnostics.push({
          checkId: "CPL028",
          severity: "warning",
          message:
            `Volume set "${name}" has fileSystemType "shared" but performanceClass "${performanceClass}". ` +
            `Control Plane forces "shared" for a shared filesystem, so the declared value will not match ` +
            `what comes back and will read as drift on every plan.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      // Custom encryption is AWS KMS on a block device; a shared filesystem has
      // no device to encrypt.
      if (fileSystemType === "shared" && readString(entity, "spec", "customEncryption", "secretLink")) {
        diagnostics.push({
          checkId: "CPL028",
          severity: "error",
          message: `Volume set "${name}" sets customEncryption with fileSystemType "shared"; it is supported on ext4 and xfs only.`,
          entity: name,
          lexicon: "cpln",
        });
      }
    }

    for (const [name, entity] of entitiesOfType(ctx.entities, WORKLOAD)) {
      const type = readString(entity, "spec", "type") ?? "serverless";
      const workloadGvc = readString(entity, "gvc");
      const paths: string[] = [];
      let mountCount = 0;

      for (const container of readArray(entity, "spec", "containers")) {
        const containerName = readString(container, "name") ?? "?";

        for (const volume of readArray(container, "volumes")) {
          mountCount++;
          const uri = readString(volume, "uri");
          const path = readString(volume, "path");
          if (path) paths.push(path);

          const match = uri ? VOLUMESET_URI.exec(uri) : null;
          if (!match) continue;

          const target = volumeSets.get(match[1]);
          if (!target) continue; // declared elsewhere; CPL029 covers dangling references

          if (EXCLUSIVE_FILESYSTEMS.has(target.fileSystemType) && type !== "stateful") {
            diagnostics.push({
              checkId: "CPL028",
              severity: "error",
              message:
                `Workload "${name}" is type "${type}" and container "${containerName}" mounts volume set ` +
                `"${match[1]}", whose fileSystemType "${target.fileSystemType}" binds to exactly one ` +
                `stateful workload. Use a "shared" volume set, or make the workload stateful.`,
              entity: name,
              lexicon: "cpln",
            });
          }

          if (target.gvc && workloadGvc && target.gvc !== workloadGvc) {
            diagnostics.push({
              checkId: "CPL028",
              severity: "error",
              message:
                `Workload "${name}" (GVC "${workloadGvc}") mounts volume set "${match[1]}" from GVC ` +
                `"${target.gvc}". Volume sets are only mountable from within their own GVC.`,
              entity: name,
              lexicon: "cpln",
            });
          }
        }
      }

      if (mountCount > MAX_VOLUMES) {
        diagnostics.push({
          checkId: "CPL028",
          severity: "error",
          message: `Workload "${name}" mounts ${mountCount} volumes; the maximum is ${MAX_VOLUMES}.`,
          entity: name,
          lexicon: "cpln",
        });
      }

      for (const [i, path] of paths.entries()) {
        for (const other of paths.slice(i + 1)) {
          if (path === other) {
            diagnostics.push({
              checkId: "CPL028",
              severity: "error",
              message: `Workload "${name}" mounts two volumes at the same path "${path}".`,
              entity: name,
              lexicon: "cpln",
            });
          } else if (isParentPath(path, other) || isParentPath(other, path)) {
            diagnostics.push({
              checkId: "CPL028",
              severity: "error",
              message:
                `Workload "${name}" mounts volumes at "${path}" and "${other}"; no mount path may be a ` +
                `parent of another.`,
              entity: name,
              lexicon: "cpln",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};

/** Whether `parent` is a proper ancestor directory of `child`. */
function isParentPath(parent: string, child: string): boolean {
  const normalized = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(normalized);
}
