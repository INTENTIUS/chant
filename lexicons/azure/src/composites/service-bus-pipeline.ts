/**
 * ServiceBusPipeline composite — ServiceBus Namespace with Queue or Topic.
 *
 * Creates a ServiceBus Namespace and either a Queue (default) or a
 * Topic + Subscription. Enforces TLS 1.2 and Standard SKU.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  ServiceBusNamespace,
  namespaces_queues,
  Sbnamespaces_topics,
  namespaces_topics_subscriptions,
} from "../generated";

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
  /** Per-member defaults. */
  defaults?: {
    namespace?: Partial<ConstructorParameters<typeof ServiceBusNamespace>[0]>;
    queue?: Partial<ConstructorParameters<typeof namespaces_queues>[0]>;
    topic?: Partial<ConstructorParameters<typeof Sbnamespaces_topics>[0]>;
    subscription?: Partial<ConstructorParameters<typeof namespaces_topics_subscriptions>[0]>;
  };
}

export interface ServiceBusPipelineResult {
  namespace: InstanceType<typeof ServiceBusNamespace>;
  queue?: InstanceType<typeof namespaces_queues>;
  topic?: InstanceType<typeof Sbnamespaces_topics>;
  subscription?: InstanceType<typeof namespaces_topics_subscriptions>;
}

export const ServiceBusPipeline = Composite<ServiceBusPipelineProps>((props) => {
  const {
    name,
    location = "[resourceGroup().location]",
    useTopic = false,
    tags = {},
    defaults,
  } = props;

  const entityName = props.entityName ?? (useTopic ? `${name}-topic` : `${name}-queue`);
  const subscriptionName = props.subscriptionName ?? `${entityName}-sub`;
  const mergedTags = { "managed-by": "chant", ...tags };

  const namespace = new ServiceBusNamespace(mergeDefaults({
    name,
    location,
    tags: mergedTags,
    sku: { name: "Standard", tier: "Standard" },
    minimumTlsVersion: "1.2",
  }, defaults?.namespace), { apiVersion: "2022-10-01-preview" });

  if (useTopic) {
    const topic = new Sbnamespaces_topics(mergeDefaults({
      name: `${name}/${entityName}`,
      maxSizeInMegabytes: 1024,
    }, defaults?.topic), {
      apiVersion: "2022-10-01-preview",
      DependsOn: [
        `[resourceId('Microsoft.ServiceBus/namespaces', '${name}')]`,
      ],
    });

    const subscription = new namespaces_topics_subscriptions(mergeDefaults({
      name: `${name}/${entityName}/${subscriptionName}`,
      maxDeliveryCount: 10,
    }, defaults?.subscription), {
      apiVersion: "2022-10-01-preview",
      DependsOn: [
        `[resourceId('Microsoft.ServiceBus/namespaces/topics', '${name}', '${entityName}')]`,
      ],
    });

    return { namespace, topic, subscription } as any;
  }

  const queue = new namespaces_queues(mergeDefaults({
    name: `${name}/${entityName}`,
    maxSizeInMegabytes: 1024,
    lockDuration: "PT1M",
    maxDeliveryCount: 10,
  }, defaults?.queue), {
    apiVersion: "2022-10-01-preview",
    DependsOn: [
      `[resourceId('Microsoft.ServiceBus/namespaces', '${name}')]`,
    ],
  });

  return { namespace, queue } as any;
}, "ServiceBusPipeline");
