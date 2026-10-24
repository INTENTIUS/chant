/**
 * Typed step-builders for the azure lexicon's verbs (#3142), the same sugar the
 * aws lexicon offers. `armDeploy({ template })` is exactly
 * `{ kind: "arm-deploy", template }`, checked against the capability's input.
 * `publishImage` is core's verb; azure contributes only the ACR login, chosen
 * by the registry host or `$env.publish.backend`.
 */
import { step } from "@intentius/chant/components";
import type { ArmDeployInput } from "./arm-deploy";
import type { WaitForDeploymentInput, WaitContainerAppInput } from "./wait-azure";

export const armDeploy = step<ArmDeployInput>("arm-deploy");
export const waitForDeployment = step<WaitForDeploymentInput>("wait-for-deployment");
export const waitContainerApp = step<WaitContainerAppInput>("wait-container-app");
