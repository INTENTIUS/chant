/**
 * Read-only MCP tools that expose what `chant build` already computes about a
 * Fly deploy — its apps and machines, the flaps create bodies, image pinning,
 * and the lexicon's findings — so an agent can ask about a change *before it
 * runs* (#804).
 *
 * Every tool builds from source and returns data. None touch a live Fly org,
 * read run history, or write anything — the same context-producer boundary the
 * AWS/GitLab context tools hold.
 */

import { build, type BuildResult } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { runPostSynthChecks, getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { postSynthChecks } from "../lint/post-synth";
import type { McpToolContribution } from "@intentius/chant/mcp/types";
import { flySerializer } from "../serializer";
import { parsePlan, isAppRequest, isMachineRequest, type FlyPlan, type FlapsRequest } from "../op/activities/fly-apply";

const PATH_INPUT = {
  type: "object" as const,
  properties: {
    path: { type: "string", description: "Path to the chant project directory (default: current directory)" },
  },
};

/** Build the project and parse the flaps plan the serializer emits. */
async function buildFly(path: string): Promise<{ plan: FlyPlan; result: BuildResult; output?: string | SerializerResult }> {
  const result = await build(path || ".", [flySerializer]);
  const output = result.outputs.get("fly");
  let plan: FlyPlan = {};
  if (output) {
    try {
      plan = parsePlan(getPrimaryOutput(output));
    } catch {
      // not a parseable fly plan — leave empty
    }
  }
  return { plan, result, output };
}

const machineImage = (req: FlapsRequest): string | undefined => {
  const config = req.body.config as { image?: unknown } | undefined;
  return typeof config?.image === "string" ? config.image : undefined;
};

/** A container image reference is pinned when it names a digest, not a tag. */
export function imagePinned(image: string): boolean {
  return image.includes("@sha256:");
}

export function flyContextTools(): McpToolContribution[] {
  return [
    {
      name: "fly:app",
      description:
        "Build the project and summarize the declared Fly apps and machines — regions, images, guest sizing — from source. Read-only; never touches a live Fly org.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { plan } = await buildFly(String(params.path ?? "."));
        const apps: Array<{ name: string; org_slug: unknown }> = [];
        const machines: Array<{ name: string; region: unknown; image: string | null; guest: unknown }> = [];
        for (const [name, req] of Object.entries(plan)) {
          if (isAppRequest(req)) {
            apps.push({ name: String(req.body.app_name ?? name), org_slug: req.body.org_slug ?? null });
          } else if (isMachineRequest(req)) {
            machines.push({
              name: String(req.body.name ?? name),
              region: req.body.region ?? null,
              image: machineImage(req) ?? null,
              guest: (req.body.config as { guest?: unknown } | undefined)?.guest ?? null,
            });
          }
        }
        return { apps, machines };
      },
    },
    {
      name: "fly:checks",
      description:
        "Build the project and return the fly lexicon's post-synth findings (machine requires an image, a mount references a declared Volume) as JSON. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { output, result } = await buildFly(String(params.path ?? "."));
        if (!output) return { findings: [], note: "no Fly plan produced from this project" };
        const scoped: BuildResult = { ...result, outputs: new Map([["fly", output]]) };
        const diags = runPostSynthChecks(postSynthChecks, scoped);
        return {
          findings: diags.map((d) => ({ id: d.checkId, severity: d.severity, entity: d.entity ?? null, message: d.message })),
        };
      },
    },
    {
      name: "fly:references",
      description:
        "Build the project and list each machine's container image and whether it is pinned to a digest (vs a floating tag). Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { plan } = await buildFly(String(params.path ?? "."));
        const images: Array<{ machine: string; image: string; pinned: boolean }> = [];
        for (const [name, req] of Object.entries(plan)) {
          if (!isMachineRequest(req)) continue;
          const image = machineImage(req);
          if (image) images.push({ machine: String(req.body.name ?? name), image, pinned: imagePinned(image) });
        }
        return images;
      },
    },
    {
      name: "fly:plan",
      description:
        "Build the project and return the flaps create bodies the serializer emits — exactly what flyApply would POST to the Machines API. Read-only.",
      inputSchema: PATH_INPUT,
      async handler(params: Record<string, unknown>): Promise<unknown> {
        const { plan } = await buildFly(String(params.path ?? "."));
        return plan;
      },
    },
  ];
}
