import { Op, phase, activity, azGroupEnsure, build, azGroupDelete } from "@intentius/chant-lexicon-temporal";

/**
 * Deploy an ARM template to Azure: ensure the resource group, build the template,
 * apply it via `az deployment group create`, then delete the group (issue #707).
 *
 * `chant run azure-deploy` executes this in-process via the local executor.
 * Requires the `az` CLI logged in (`az login`). chant emits the ARM template; the
 * `arm` target of `nativeApply` runs `az deployment group create`, which needs the
 * resource group to exist first — hence the `azGroupEnsure` phase.
 *
 * This is the real-Azure path. Local emulation against floci-az awaits an upstream
 * `Microsoft.Resources/deployments` provider (#705).
 */
export default Op({
  name: "azure-deploy",
  overview: "az group ensure → build → arm deploy → group delete: a first-class Azure deploy",
  taskQueue: "azure-deploy",
  phases: [
    phase("Group", [
      azGroupEnsure("chant-rg", { location: "eastus" }),
    ]),
    phase("Build", [
      build("."),
    ]),
    phase("Deploy", [
      activity("nativeApply", { target: "arm", env: "chant-rg", output: "dist/stack.json" }),
    ]),
    phase("Teardown", [
      azGroupDelete("chant-rg"),
    ]),
  ],
});
