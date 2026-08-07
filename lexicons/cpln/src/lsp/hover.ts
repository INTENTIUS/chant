import { createRequire } from "module";
import type { HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { LexiconIndex, lexiconHover, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { KINDS, kindByClassName } from "../kinds";

const require = createRequire(import.meta.url);

let cachedIndex: LexiconIndex | null = null;

function getIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const data = require("../generated/lexicon-cpln.json") as Record<string, LexiconEntry>;
  cachedIndex = new LexiconIndex(data);
  return cachedIndex;
}

/**
 * Per-kind notes.
 *
 * These carry the rules an author cannot infer from the property names, and
 * specifically the ones whose violation fails *silently* — an unqualified
 * identity link, a scale-to-zero that never happens, an immutable field. The
 * property list is already in the types; what hover adds is the part the types
 * cannot say.
 */
const KIND_NOTES: Record<string, string> = {
  Gvc:
    "The placement and networking boundary. Workloads, identities and volume sets live inside one.\n\n" +
    "Placement is set here, not per workload (`spec.staticPlacement.locationLinks`, e.g. " +
    "`/org/acme/location/aws-us-east-1`). **Pull secrets are also GVC-level** (`spec.pullSecretLinks`) — " +
    "only `docker`, `ecr` and `gcp` secret types are valid. KEDA must be enabled here before a standard or " +
    "stateful workload in the GVC can use it.",

  Workload:
    "A running unit of work. **`type` and `name` are immutable** — changing either means delete and recreate.\n\n" +
    "- `serverless` — exactly one HTTP port, required. Scales to zero with `rps` or `concurrency`.\n" +
    "- `standard` — multiple ports, non-HTTP allowed. Scale to zero via KEDA only.\n" +
    "- `stateful` — stable replica identity; the only type that mounts `ext4`/`xfs` volumes or uses " +
    "`replicaDirect` load balancing.\n" +
    "- `cron` — must set `spec.job.schedule` and expose no ports. Probes, autoscaling and `timeoutSeconds` " +
    "are accepted and ignored.\n\n" +
    "Capacity AI is **on by default** for serverless, standard and cron, and conflicts with CPU-utilization " +
    "autoscaling, multi-metric autoscaling, and GPUs. Memory(MiB)/CPU(millicores) must be ≤ 8.",

  Identity:
    "A workload's identity: cloud-provider access, network resources, and the principal a policy grants to.\n\n" +
    "**GVC-scoped and not shareable** — an identity cannot be used from another GVC; declare one per GVC with " +
    "the same spec. A workload has at most one. Each provider section allows one account " +
    "(AWS `roleName` ⊻ `policyRefs`, GCP `serviceAccount` ⊻ `bindings`).\n\n" +
    "In a policy binding the principal must be `//gvc/GVC/identity/NAME`. The bare `//identity/NAME` is " +
    "**silently ignored** (CPL013).",

  VolumeSet:
    "Persistent storage inside one GVC.\n\n" +
    "**`fileSystemType` and `performanceClass` are both immutable** — changing either means delete, recreate, " +
    "and data loss. `ext4`/`xfs` are RWO and bind to exactly one *stateful* workload; `shared` is RWX, works " +
    "with any type, and supports no snapshots. `high-throughput-ssd` has a 200 GB floor where the others have " +
    "10 GB. Mount with `cpln://volumeset/NAME`.",

  Secret:
    "An org-scoped secret, in one of 12 types.\n\n" +
    "Reading one at runtime takes three steps, and **missing any one fails silently**: the workload has an " +
    "identity, a policy grants that identity `reveal` on the secret, and the reference is field-qualified — " +
    "`cpln://secret/NAME.payload`, not `cpln://secret/NAME` (CPL014).",

  Policy:
    "Binds permissions to principals over a target.\n\n" +
    "`targetKind` is singular and lowercase. Pick exactly one scope: `target: \"all\"`, `targetLinks`, or " +
    "`targetQuery`. `ipset` and `mk8s` are **not** valid targets — they are governed through their parent. " +
    "Permissions in a binding must be sorted and unique. Never set `origin` by hand.",

  Domain:
    "A custom domain with its TLS, CORS and routing.\n\n" +
    "**Apex domains must use `dnsMode: cname`** — NS does not support apex. NS mode requires " +
    "`certChallengeType: dns01`. `gvcLink`, `workloadLink` and `ports[].routes` are mutually exclusive, and " +
    "`workloadLink` (replica-direct) is stateful-only. Every route must target workloads in one GVC.",

  IpSet:
    "Dedicated IP addresses reserved in named locations and bound to a workload.\n\n" +
    "Not a valid policy target — access is governed through the workload it fronts.",
};

/** Enum-valued props are worth spelling out inline — they are the typo surface. */
function enumLines(entry: LexiconEntry): string[] {
  const constraints = entry.propertyConstraints as Record<string, { enum?: unknown[] }> | undefined;
  if (!constraints) return [];

  const lines: string[] = [];
  for (const [prop, constraint] of Object.entries(constraints)) {
    if (!Array.isArray(constraint?.enum) || constraint.enum.length === 0) continue;
    lines.push(`- \`${prop}\`: ${constraint.enum.map((v) => `\`${String(v)}\``).join(" | ")}`);
  }
  return lines;
}

function cplnHover(className: string, entry: LexiconEntry): HoverInfo | undefined {
  const lines: string[] = [`**${className}**`, "", `Control Plane type: \`${entry.resourceType}\``];

  const kind = kindByClassName(className);
  if (!kind) {
    // A property type — a nested shape rather than a standalone declarable.
    // Naming its owner is the useful part, since the names are path-derived.
    const owner = KINDS.find((k) => className.startsWith(k.className));
    lines.push(
      "",
      owner
        ? `*Property type — a nested shape within \`${owner.className}\`, not a standalone declarable.*`
        : "*Property type — a nested shape, not a standalone declarable.*",
    );
    const propertyEnums = enumLines(entry);
    if (propertyEnums.length > 0) lines.push("", "Enumerated properties:", ...propertyEnums);
    return { contents: lines.join("\n") };
  }

  lines.push("", `Manifest kind: \`${kind.kind}\``);
  if (kind.gvcScoped) lines.push("", "GVC-scoped — requires a `gvc`.");

  const note = KIND_NOTES[className];
  if (note) lines.push("", note);

  const enums = enumLines(entry);
  if (enums.length > 0) lines.push("", "Enumerated properties:", ...enums);

  return { contents: lines.join("\n") };
}

/** Provide LSP hover information for cpln resources. */
export function hover(ctx: HoverContext): HoverInfo | undefined {
  return lexiconHover(ctx, getIndex(), cplnHover);
}
