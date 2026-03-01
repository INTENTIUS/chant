/**
 * ServiceBusPipeline composite — ServiceBus Namespace with Queue or Topic.
 *
 * Creates a ServiceBus Namespace and either a Queue (default) or a
 * Topic + Subscription. Enforces TLS 1.2 and Standard SKU.
 */

import { markAsAzureResource } from "./from-arm";

export interface ServiceBusPipelineProps {
  /** Namespace name. */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Queue or topic name (default: "{name}-queue"). */
  entityName?: string;
  /** Use topic+subscription instead of a queue (default: false). */
  useTopic?: boolean;
  /** Subscription name when useTopic is true (default: "{entityName}-sub"). */
  subscriptionName?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface ServiceBusPipelineResult {
  namespace: Record<string, unknown>;
  queue?: Record<string, unknown>;
  topic?: Record<string, unknown>;
  subscription?: Record<string, unknown>;
}

export function ServiceBusPipeline(props: ServiceBusPipelineProps): ServiceBusPipelineResult {
  const {
    name,
    location = "[resourceGroup().location]",
    useTopic = false,
    tags = {},
  } = props;

  const entityName = props.entityName ?? (useTopic ? `${name}-topic` : `${name}-queue`);
  const subscriptionName = props.subscriptionName ?? `${entityName}-sub`;
  const mergedTags = { "managed-by": "chant", ...tags };

  const namespace: Record<string, unknown> = {
    type: "Microsoft.ServiceBus/namespaces",
    apiVersion: "2022-10-01-preview",
    name,
    location,
    tags: mergedTags,
    sku: { name: "Standard", tier: "Standard" },
    properties: {
      minimumTlsVersion: "1.2",
    },
  };

  if (useTopic) {
    const topic: Record<string, unknown> = {
      type: "Microsoft.ServiceBus/namespaces/topics",
      apiVersion: "2022-10-01-preview",
      name: `${name}/${entityName}`,
      properties: {
        maxSizeInMegabytes: 1024,
      },
      dependsOn: [
        `[resourceId('Microsoft.ServiceBus/namespaces', '${name}')]`,
      ],
    };

    const subscription: Record<string, unknown> = {
      type: "Microsoft.ServiceBus/namespaces/topics/subscriptions",
      apiVersion: "2022-10-01-preview",
      name: `${name}/${entityName}/${subscriptionName}`,
      properties: {
        maxDeliveryCount: 10,
      },
      dependsOn: [
        `[resourceId('Microsoft.ServiceBus/namespaces/topics', '${name}', '${entityName}')]`,
      ],
    };

    markAsAzureResource(namespace);
    markAsAzureResource(topic);
    markAsAzureResource(subscription);

    return { namespace, topic, subscription };
  }

  const queue: Record<string, unknown> = {
    type: "Microsoft.ServiceBus/namespaces/queues",
    apiVersion: "2022-10-01-preview",
    name: `${name}/${entityName}`,
    properties: {
      maxSizeInMegabytes: 1024,
      lockDuration: "PT1M",
      maxDeliveryCount: 10,
    },
    dependsOn: [
      `[resourceId('Microsoft.ServiceBus/namespaces', '${name}')]`,
    ],
  };

  markAsAzureResource(namespace);
  markAsAzureResource(queue);

  return { namespace, queue };
}
