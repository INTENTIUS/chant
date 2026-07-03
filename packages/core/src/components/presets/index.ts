/**
 * Preset library (#566, epic #551 §"6. Presets (Level 2 reuse)") — named
 * composition builders for the common component shapes. Each preset expands
 * to a full, valid `Component` (../component.ts): the same typed authoring
 * form and JSON contract every hand-composed component projects to, so a
 * preset-based component and a hand-composed one are indistinguishable to
 * `projectToJson`, schema validation, lint, and the driver.
 *
 * This is Level 2 reuse over Level 1 raw capabilities
 * (docs/components/capabilities.mdx#presets--reuse-without-a-closed-set): a
 * component that matches one of these shapes calls the preset directly; the
 * odd one that needs something extra spreads the returned `Component` and
 * edits `deploy`/`rollback` where it is special. Presets remove composition
 * copy-paste (the COMP007 lint hint) without creating a closed strategy set —
 * see ./ecs-fargate.test.ts, ./lambda.test.ts, and
 * ./single-host-compose.test.ts, each of which re-derives an existing
 * hand-composed pilot/fixture from its preset and asserts the two project to
 * the identical JSON contract.
 *
 * Deliberately not exhaustive: three presets covering the three archetypes'
 * most common shapes (a load-balanced container service, a container-image
 * Lambda function, and a registry-less single-host compose deploy), per
 * #566's explicit scope ("start with the common shapes; an exhaustive
 * catalog is out of scope").
 */

export { EcsFargateComponent, type EcsFargateComponentConfig } from "./ecs-fargate";
export { LambdaComponent, type LambdaComponentConfig } from "./lambda";
export {
  SingleHostComposeComponent,
  type SingleHostComposeComponentConfig,
} from "./single-host-compose";
