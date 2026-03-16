/**
 * ContainerInstance composite — Container Group.
 *
 * Creates a Container Group with managed identity and no public IP by default.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { containerGroups } from "../generated";

export interface ContainerInstanceProps {
  /** Container group name. */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Container image (default: "mcr.microsoft.com/hello-world"). */
  image?: string;
  /** CPU cores (default: 1). */
  cpu?: number;
  /** Memory in GB (default: 1.5). */
  memoryInGb?: number;
  /** Container port (default: 80). */
  port?: number;
  /** Whether to expose a public IP (default: false). */
  publicIp?: boolean;
  /** Resource tags. */
  tags?: Record<string, string>;
  /** Per-member defaults. */
  defaults?: {
    containerGroup?: Partial<ConstructorParameters<typeof containerGroups>[0]>;
  };
}

export interface ContainerInstanceResult {
  containerGroup: InstanceType<typeof containerGroups>;
}

export const ContainerInstance = Composite<ContainerInstanceProps>((props) => {
  const {
    name,
    location = "[resourceGroup().location]",
    image = "mcr.microsoft.com/hello-world",
    cpu = 1,
    memoryInGb = 1.5,
    port = 80,
    publicIp = false,
    tags = {},
    defaults,
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };

  const containerGroup = new containerGroups(mergeDefaults({
    name,
    location,
    tags: mergedTags,
    identity: { type: "SystemAssigned" },
    osType: "Linux",
    restartPolicy: "OnFailure",
    ipAddress: {
      type: publicIp ? "Public" : "Private",
      ports: [{ protocol: "TCP", port }],
    },
    containers: [
      {
        name: `${name}-container`,
        properties: {
          image,
          ports: [{ port }],
          resources: {
            requests: { cpu, memoryInGB: memoryInGb },
          },
        },
      },
    ],
  }, defaults?.containerGroup), { apiVersion: "2023-05-01" });

  return { containerGroup };
}, "ContainerInstance");
