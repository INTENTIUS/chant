import { Composite, mergeDefaults } from "@intentius/chant";
import type { Step } from "../generated/index";

export interface DownloadArtifactProps {
  name?: string;
  path?: string;
  mergeMultiple?: boolean;
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const DownloadArtifact = Composite<DownloadArtifactProps>((props) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {};
  if (props.name !== undefined) withObj.name = props.name;
  if (props.path !== undefined) withObj.path = props.path;
  if (props.mergeMultiple !== undefined) withObj["merge-multiple"] = String(props.mergeMultiple);

  const { createProperty } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const step = new StepClass(mergeDefaults({
    name: "Download Artifact",
    uses: "actions/download-artifact@v4",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  }, defaults?.step));

  return { step };
}, "DownloadArtifact");
