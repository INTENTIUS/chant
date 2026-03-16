import { Composite, mergeDefaults } from "@intentius/chant";
import type { Step } from "../generated/index";

export interface UploadArtifactProps {
  name: string;
  path: string;
  retentionDays?: number;
  compressionLevel?: number;
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const UploadArtifact = Composite<UploadArtifactProps>((props) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {
    name: props.name,
    path: props.path,
  };
  if (props.retentionDays !== undefined) withObj["retention-days"] = String(props.retentionDays);
  if (props.compressionLevel !== undefined) withObj["compression-level"] = String(props.compressionLevel);

  const { createProperty } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const step = new StepClass(mergeDefaults({
    name: "Upload Artifact",
    uses: "actions/upload-artifact@v4",
    with: withObj,
  }, defaults?.step));

  return { step };
}, "UploadArtifact");
