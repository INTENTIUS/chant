import { Op, phase, shell, build, azApply } from "@intentius/chant-lexicon-temporal";

/**
 * Deploy the storage account to a local floci-az via `azApply`. `chant run azure`.
 * Requires Docker + `curl`. floci-az has no `az deployment`, so azApply PUTs the
 * ARM resources directly (resolving the ARM expressions first).
 */
export default Op({
  name: "azure",
  overview: "Azure: storage account → floci-az (direct ARM apply), local, no account",
  taskQueue: "trio-azure",
  phases: [
    phase("Emulator", [shell("docker run -d --rm --name trio-az -p 4577:4577 floci/floci-az:latest")]),
    phase("Build", [build(".", { script: "build:azure" })]),
    phase("Apply", [azApply("dist/azure.json", { resourceGroup: "trio-rg", location: "eastus", endpoint: "http://localhost:4577" })]),
    phase("Verify", [
      shell(
        "curl -fs 'http://localhost:4577/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/trio-rg/providers/Microsoft.Storage/storageAccounts/triostore?api-version=2025-06-01'",
      ),
    ]),
    phase("Teardown", [shell("docker rm -f trio-az")]),
  ],
});
