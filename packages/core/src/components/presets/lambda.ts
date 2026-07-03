/**
 * Preset: `LambdaComponent` (#566, epic #551 §"6. Presets (Level 2 reuse)").
 *
 * The named-composition builder for the container-image Lambda shape
 * (`../pilots/lambda.pilot.ts`): `docker-build` -> `publish-image` ->
 * `lambda-deploy` -> `health-gate` against the function's alias. Distinct
 * from `EcsFargateComponent`'s apply family on purpose — no CloudFormation
 * stack in Apply at all, matching the pilot's documented "first pilot whose
 * Apply phase contains no cfn-deploy" shape.
 */

import type { Component } from "../component";
import { phase } from "../component";

export interface LambdaComponentConfig {
  /** Component name (kebab-case) — becomes both the component's `name` and, by default, the Lambda function name. */
  name: string;
  /** Lambda function name. Default: `name`. */
  functionName?: string;
  /** Docker build context. Default: ".". */
  context?: string;
  /** Alias to repoint at the new version after publish. Default: "live". */
  alias?: string;
  /** Destination registry `publish-image` promotes to. Default: `"$env.registry"`. */
  registry?: string;
  /** Other components that must complete first. */
  dependsOn?: string[];
}

/**
 * Expand a container-image AWS Lambda function to its standard
 * Publish/Apply/Verify composition — the reference shape
 * `lambda.pilot.ts` hand-composes. Reuses `docker-build`/`publish-image`
 * unchanged from `EcsFargateComponent`'s build axis (build + promote-by-digest
 * is identical for a container-image Lambda); only the apply/verify shape
 * differs.
 */
export function LambdaComponent(config: LambdaComponentConfig): Component {
  const functionName = config.functionName ?? config.name;
  const alias = config.alias ?? "live";

  return {
    name: config.name,
    archetype: "service",
    dependsOn: config.dependsOn ?? [],
    build: { kind: "docker-build", context: config.context ?? ".", into: "archive" },
    deploy: [
      phase("Publish", [{ kind: "publish-image", from: "archive", to: config.registry ?? "$env.registry" }]),
      phase("Apply", [{ kind: "lambda-deploy", functionName, codeRef: "@Publish.uri", alias }]),
      phase("Verify", [{ kind: "health-gate", path: "@Apply.functionArn" }]),
    ],
  };
}
