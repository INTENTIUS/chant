/**
 * Preset: `EcsFargateComponent` (#566, epic #551 §"6. Presets (Level 2 reuse)").
 *
 * The named-composition builder for the ALB/ECS shape
 * (`../pilots/alb-ecs.pilot.ts`): `docker-build` -> `publish-image` ->
 * `cfn-deploy` (importing a shared ALB's cross-stack outputs) ->
 * `ecs-update-service` -> `wait-steady-state` + `health-gate`, with the same
 * component-declared `rollback-previous` compensation phase the pilot uses
 * (no native rollback for an already-running service swap — see
 * ../pilots/alb-ecs.pilot.ts's docstring).
 *
 * This is Level 2 reuse over Level 1 raw capabilities: a component that looks
 * like this composes `EcsFargateComponent({ ... })` directly; the odd case
 * that needs something extra starts from the same shape and drops to raw
 * `phase()`/capability `Step`s where it is special (see
 * docs/components/capabilities.mdx#presets--reuse-without-a-closed-set) —
 * `./ecs-fargate.test.ts` demonstrates exactly that by re-deriving
 * `alb-ecs.pilot.ts`'s `searchService` component from this preset and
 * asserting the two project to the identical JSON contract.
 */

import type { Component, Wiring } from "../component";
import { phase, stackOutput } from "../component";

export interface EcsFargateComponentConfig {
  /** Component/service name (kebab-case) — becomes both the component's `name` and the ECS service name unless `service` overrides it. */
  name: string;
  /** ECS service name. Default: `name`. */
  service?: string;
  /** Docker build context. Default: ".". */
  context?: string;
  /** Path to the built CloudFormation template inside the archive. Default: `archive:<name>.template.json`. */
  template?: string;
  /** Health check path for the post-deploy `health-gate`. */
  healthPath: string;
  /** Other components that must complete first, beyond the shared-ALB stack (if any). */
  dependsOn?: string[];
  /**
   * Shared ALB stack this service imports `ListenerArn`/`ClusterArn`/`Subnets`
   * from, via cross-stack `stackOutput()` wiring — the same axis
   * `alb-ecs.pilot.ts` exercises. Omit for a service with its own
   * self-contained stack (no shared-ALB import; `cfn-deploy` receives no
   * `inputs`).
   */
  sharedAlbStack?: string;
  /** Additional/override CloudFormation template inputs, merged with (and taking precedence over) the shared-ALB outputs. */
  extraInputs?: Record<string, Wiring>;
  /** ECS cluster reference passed to `ecs-update-service`. Default: `"$env.cluster"`. */
  cluster?: Wiring;
  /** Destination registry `publish-image` promotes to. Default: `"$env.registry"`. */
  registry?: Wiring;
}

/**
 * Expand an ECS/Fargate service behind an ALB to its standard
 * Publish/Apply/Verify composition — the 80% shape `alb-ecs.pilot.ts` is the
 * hand-composed reference for. Returns a full `Component`; a caller that
 * needs one extra step (an additional Apply capability, a different Verify
 * shape) spreads the result and edits `deploy`/`rollback` directly — the
 * preset is a starting composition, not a closed strategy object.
 */
export function EcsFargateComponent(config: EcsFargateComponentConfig): Component {
  const service = config.service ?? config.name;
  const template = config.template ?? `archive:${config.name}.template.json`;
  const cluster = config.cluster ?? "$env.cluster";
  const registry = config.registry ?? "$env.registry";

  const sharedAlbOutputs = config.sharedAlbStack
    ? {
        listenerArn: stackOutput(config.sharedAlbStack, "ListenerArn"),
        clusterArn: stackOutput(config.sharedAlbStack, "ClusterArn"),
        subnets: stackOutput(config.sharedAlbStack, "Subnets"),
      }
    : undefined;
  const inputs =
    sharedAlbOutputs || config.extraInputs ? { ...sharedAlbOutputs, ...config.extraInputs } : undefined;

  const dependsOn = [...(config.sharedAlbStack ? [config.sharedAlbStack] : []), ...(config.dependsOn ?? [])];

  return {
    name: config.name,
    archetype: "service",
    dependsOn,
    build: { kind: "docker-build", context: config.context ?? ".", into: "archive" },
    deploy: [
      phase("Publish", [{ kind: "publish-image", from: "archive", to: registry }]),
      phase("Apply", [
        {
          kind: "cfn-deploy",
          template,
          imageRef: "@Publish.digest",
          ...(inputs ? { inputs } : {}),
        },
        { kind: "ecs-update-service", cluster, service },
      ]),
      phase("Verify", [
        { kind: "wait-steady-state", service },
        { kind: "health-gate", path: config.healthPath },
      ]),
    ],
    rollback: [phase("Rollback", [{ kind: "rollback-previous", service, cluster }])],
  };
}
