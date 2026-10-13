/**
 * TF032: an ECS container definition passes a credential as a plaintext
 * environment value.
 *
 * The Terraform counterpart of the aws lexicon's WAW046. A value under a
 * container's `environment` is stored verbatim in the task definition: it is
 * readable by anyone with `ecs:DescribeTaskDefinition`, it shows in the
 * console, and it is in Terraform state and plan output. ECS has a field for
 * exactly this, `secrets`, whose `valueFrom` is a Secrets Manager or SSM
 * Parameter Store ARN that the agent resolves at task start. A credential
 * belongs there.
 *
 * Why this is a native rule and not WAW046 through a bridge
 * (docs/design/waw-hcl-fidelity-probe.md): `container_definitions` is a JSON
 * string. In HCL it is almost always `jsonencode([...])`, which hcl2json hands
 * back as the call's unevaluated source text, so the structure WAW046 reads
 * does not exist in the parse until something reads that text.
 * `../../hcl/jsonencode.ts` does, for literal structure only, and never
 * evaluates anything.
 *
 * The three answers, per task definition:
 *
 * - Readable. `container_definitions` is `jsonencode([...])` whose list and
 *   containers are literal, or a plain JSON string (a heredoc with no
 *   interpolation is one). A reference or function call in a leaf
 *   (`image = var.image`, `value = var.db_password`) does not stop the read:
 *   that leaf is unknown and the literal fields beside it are still read. An
 *   environment entry whose value is a reference is skipped, since a
 *   reference is not a committed literal (TF007 and TF022 judge where the
 *   referenced value comes from).
 * - Violation. A readable environment entry whose `value` is a literal string
 *   and is secret-shaped by `../secret-shape.ts`: a credential-looking name
 *   with a literal of at least 8 characters that is not a placeholder, or a
 *   value that is a credential on its own (a vendor key shape, a JWT, a PEM
 *   key, a high-entropy token) whatever it is called.
 * - Not determined. `container_definitions` is a reference
 *   (`local.defs`, `data.template_file.x.rendered`), `file()`,
 *   `templatefile()`, a heredoc or string with interpolation, a jsonencode
 *   argument that is not a literal list (`jsonencode(concat(...))`,
 *   `jsonencode(local.containers)`), or a container whose `environment` is an
 *   expression (`environment = local.env`). One `info` diagnostic starting
 *   `Not determined:` per task definition or container, never a warning.
 *
 * Absence: a container with no `environment` is not insecure, and a task
 * definition with no `container_definitions` is not reported (the attribute
 * is required, so that is a plan error, not this rule's finding). A name in
 * `secrets` is never reported: `secrets` is not read at all.
 *
 * Findings never carry the value, only its length.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { RESOURCE_TYPE } from "../../hcl/parse";
import { attr } from "../../hcl/value";
import { isUnknown, readJsonencode } from "../../hcl/jsonencode";
import { secretShapedAssignment } from "../secret-shape";
import { blocksOfType, type TerraformBlock } from "./blocks";

const TASK_DEFINITION = "aws_ecs_task_definition";

/** The container definitions of one task definition, or why they cannot be read. */
export type ContainerDefinitionsRead =
  | { kind: "readable"; containers: unknown }
  | { kind: "not-determined"; reason: string }
  | { kind: "absent" };

/**
 * Read `container_definitions` as structure without evaluating anything.
 * `jsonencode(...)` goes through the shared reader with unknown leaves; a
 * plain string with no interpolation is JSON (a heredoc arrives as one);
 * everything else is named in the not-determined reason.
 */
export function readContainerDefinitions(body: Record<string, unknown>): ContainerDefinitionsRead {
  const raw = body.container_definitions;
  if (raw === undefined || raw === null) return { kind: "absent" };

  const encoded = readJsonencode(raw, { unknownLeaves: true });
  if (encoded.kind === "literal") return { kind: "readable", containers: encoded.value };
  if (encoded.kind === "not-determined") {
    return { kind: "not-determined", reason: `its jsonencode argument holds ${encoded.reason}` };
  }

  if (typeof raw !== "string") return { kind: "not-determined", reason: "it is not a string" };
  // attr() alone is not enough to call a string literal: its interpolation
  // pattern tolerates one level of nested braces, so a deeper expression can
  // read as `literal`. Any `${` at all means the parse did not hand us text.
  if (!raw.includes("${")) {
    try {
      return { kind: "readable", containers: JSON.parse(raw) };
    } catch {
      return { kind: "not-determined", reason: "it is a string that is not valid JSON" };
    }
  }
  return { kind: "not-determined", reason: describeExpression(raw) };
}

/** Name the expression an unreadable `container_definitions` holds, for the message. */
function describeExpression(raw: string): string {
  const a = attr({ v: raw }, "v");
  if (a.kind === "reference" && a.refs?.[0] !== undefined) {
    const expr = a.refs[0];
    const call = /^([a-z_][a-z0-9_]*)\s*\(/i.exec(expr);
    if (call) return `it is a call to ${call[1]}(), which this rule does not evaluate`;
    return `it is the reference \`${expr}\`, whose value is not in this module's source`;
  }
  return "it is a string or heredoc with interpolation, which this rule does not evaluate";
}

/** A container's display name: its literal `name`, else its position. */
function containerName(container: Record<string, unknown>, index: number): string {
  return typeof container.name === "string" ? container.name : `#${index}`;
}

function notDetermined(block: TerraformBlock, what: string, reason: string): PostSynthDiagnostic {
  return {
    checkId: "TF032",
    severity: "info",
    message:
      `Not determined: "${block.address}" ${what}: ${reason}. TF032 reads only literal structure, ` +
      "so a plaintext credential in it can be neither found nor ruled out.",
    entity: block.key,
    lexicon: "terraform",
  };
}

export function checkEcsPlaintextCredentials(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const block of blocksOfType(ctx, RESOURCE_TYPE)) {
    if (!block.address.startsWith(`${TASK_DEFINITION}.`)) continue;

    const read = readContainerDefinitions(block.body);
    if (read.kind === "absent") continue;
    if (read.kind === "not-determined") {
      diagnostics.push(notDetermined(block, "`container_definitions`", read.reason));
      continue;
    }
    // A literal that is not a list is not a valid container_definitions; the
    // provider rejects it at plan, and there is no environment to read.
    if (!Array.isArray(read.containers)) continue;

    read.containers.forEach((container, index) => {
      if (isUnknown(container)) {
        diagnostics.push(
          notDetermined(block, `container #${index} of \`container_definitions\``, `it is ${container.reason}`),
        );
        return;
      }
      if (typeof container !== "object" || container === null || Array.isArray(container)) return;
      const c = container as Record<string, unknown>;
      const name = containerName(c, index);

      const env = c.environment;
      if (env === undefined || env === null) return;
      if (isUnknown(env)) {
        diagnostics.push(notDetermined(block, `container "${name}" \`environment\``, `it is ${env.reason}`));
        return;
      }
      if (!Array.isArray(env)) return;

      const unreadable: string[] = [];
      for (const entry of env) {
        if (isUnknown(entry)) {
          unreadable.push(entry.reason);
          continue;
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        if (isUnknown(e.name)) {
          // A computed variable name could be anything, so the entry is
          // unreadable only when it also carries a literal value to judge.
          if (typeof e.value === "string") unreadable.push(e.name.reason);
          continue;
        }
        if (typeof e.name !== "string") continue;
        // A reference value is the remediation's neighbour, not a literal:
        // skipped. Numbers and booleans are not credentials.
        if (typeof e.value !== "string") continue;

        const shape = secretShapedAssignment(e.name, e.value);
        if (!shape) continue;
        const why =
          shape.reason === "name"
            ? "its name reads like a credential"
            : "the value has the shape of a credential";
        diagnostics.push({
          checkId: "TF032",
          severity: "error",
          message:
            `"${block.address}" container "${name}" passes "${e.name}" as a plaintext environment value ` +
            `(${shape.length} characters, redacted here; ${why}). It is stored in the task definition, ` +
            "visible to anyone who can describe it, and in state and plan output. Move it to the " +
            "container's `secrets` with a `valueFrom` naming a Secrets Manager secret or SSM parameter, " +
            "and rotate the committed value.",
          entity: block.key,
          lexicon: "terraform",
        });
      }

      if (unreadable.length > 0) {
        diagnostics.push(
          notDetermined(
            block,
            `container "${name}" \`environment\``,
            `${unreadable.length} entr${unreadable.length === 1 ? "y is" : "ies are"} not literal (${unreadable[0]})`,
          ),
        );
      }
    });
  }

  return diagnostics;
}

export const tf032: PostSynthCheck = {
  id: "TF032",
  description: "ECS container definition passes a credential as a plaintext environment value",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkEcsPlaintextCredentials(ctx);
  },
};
