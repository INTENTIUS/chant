import { Op, phase, build, azApply, flociAzUp, flociAzDown, httpCheck } from "@intentius/chant-lexicon-temporal";

/**
 * Deploy the storage account to a local floci-az via `azApply`. `chant run azure`.
 * Requires Docker. floci-az has no `az deployment`, so azApply PUTs the ARM
 * resources directly (resolving the ARM expressions first). Every phase is a
 * modeled activity — boot, build, apply, verify, teardown — with no raw shell.
 */
export default Op({
  name: "azure",
  overview: "Azure: storage account → floci-az (direct ARM apply), local, no account",
  taskQueue: "trio-azure",
  phases: [
    phase("Emulator", [flociAzUp()]),
    phase("Build", [build(".", { script: "build:azure" })]),
    phase("Apply", [azApply("dist/azure.json", { resourceGroup: "trio-rg", location: "eastus", endpoint: "http://localhost:4577" })]),
    phase("Verify", [
      httpCheck(
        "http://localhost:4577/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/trio-rg/providers/Microsoft.Storage/storageAccounts/triostore?api-version=2025-06-01",
      ),
    ]),
    phase("Teardown", [flociAzDown()]),
  ],
});
