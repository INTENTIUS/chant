/**
 * ContainerInstance composite — Container Group.
 *
 * Creates a Container Group with managed identity and no public IP by default.
 */

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
}

export interface ContainerInstanceResult {
  containerGroup: Record<string, unknown>;
}

export function ContainerInstance(props: ContainerInstanceProps): ContainerInstanceResult {
  const {
    name,
    location = "[resourceGroup().location]",
    image = "mcr.microsoft.com/hello-world",
    cpu = 1,
    memoryInGb = 1.5,
    port = 80,
    publicIp = false,
    tags = {},
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };

  const containerGroup: Record<string, unknown> = {
    type: "Microsoft.ContainerInstance/containerGroups",
    apiVersion: "2023-05-01",
    name,
    location,
    tags: mergedTags,
    identity: { type: "SystemAssigned" },
    properties: {
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
    },
  };

  return { containerGroup };
}
