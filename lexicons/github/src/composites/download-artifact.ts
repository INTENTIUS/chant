import { Composite } from "@intentius/chant";

export interface DownloadArtifactProps {
  name?: string;
  path?: string;
  mergeMultiple?: boolean;
}

export const DownloadArtifact = Composite<DownloadArtifactProps>((props) => {
  const withObj: Record<string, string> = {};
  if (props.name !== undefined) withObj.name = props.name;
  if (props.path !== undefined) withObj.path = props.path;
  if (props.mergeMultiple !== undefined) withObj["merge-multiple"] = String(props.mergeMultiple);

  const { createProperty } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const step = new StepClass({
    name: "Download Artifact",
    uses: "actions/download-artifact@v4",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  });

  return { step };
}, "DownloadArtifact");
