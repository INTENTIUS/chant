/**
 * ARM pseudo-parameters — references to deployment-time values.
 *
 * These serialize to ARM template expressions:
 *   Azure.ResourceGroupName → "[resourceGroup().name]"
 *   Azure.SubscriptionId   → "[subscription().subscriptionId]"
 */

import { INTRINSIC_MARKER, type Intrinsic } from "@intentius/chant/intrinsic";

class ArmPseudoParameter implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private expression: string;
  private displayName: string;

  constructor(expression: string, displayName: string) {
    this.expression = expression;
    this.displayName = displayName;
  }

  toJSON(): string {
    return this.expression;
  }

  toString(): string {
    return this.displayName;
  }
}

export const ResourceGroupName = new ArmPseudoParameter(
  "[resourceGroup().name]",
  "Azure.ResourceGroupName",
);

export const ResourceGroupLocation = new ArmPseudoParameter(
  "[resourceGroup().location]",
  "Azure.ResourceGroupLocation",
);

export const ResourceGroupId = new ArmPseudoParameter(
  "[resourceGroup().id]",
  "Azure.ResourceGroupId",
);

export const SubscriptionId = new ArmPseudoParameter(
  "[subscription().subscriptionId]",
  "Azure.SubscriptionId",
);

export const TenantId = new ArmPseudoParameter(
  "[subscription().tenantId]",
  "Azure.TenantId",
);

export const DeploymentName = new ArmPseudoParameter(
  "[deployment().name]",
  "Azure.DeploymentName",
);

/**
 * Azure namespace containing all pseudo-parameters.
 */
export const Azure = {
  ResourceGroupName,
  ResourceGroupLocation,
  ResourceGroupId,
  SubscriptionId,
  TenantId,
  DeploymentName,
} as const;
