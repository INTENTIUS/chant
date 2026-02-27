import {
  StorageAccountSecure,
  AppService,
  ResourceId,
  Reference,
  Concat,
  UniqueString,
  ListKeys,
  Azure,
} from "@intentius/chant-lexicon-azure";

// --- Storage layer ---

const storageName = Concat("appdata", UniqueString(Azure.ResourceGroupId)) as unknown as string;

export const { storageAccount } = StorageAccountSecure({
  name: storageName,
  sku: "Standard_LRS",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { layer: "data" },
});

// --- Web layer ---

export const { plan, webApp } = AppService({
  name: "multi-res-app",
  sku: "B1",
  runtime: "NODE|18-lts",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { layer: "web" },
});

// --- Cross-resource references ---

const storageAccountId = ResourceId(
  "Microsoft.Storage/storageAccounts",
  storageName,
);

const storageKeys = ListKeys(storageAccountId, "2023-01-01");

const storageRef = Reference("storageAccount", "2023-01-01");

// Export intrinsic references so the serializer can wire them into outputs
export const storageConnectionResourceId = storageAccountId;
export const storageConnectionKeys = storageKeys;
export const storageConnectionRef = storageRef;
