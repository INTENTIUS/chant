import { Composite, mergeDefaults } from "@intentius/chant";
import { actionRef } from "../action-pins";
import { Step } from "../generated/index";

export interface UploadArtifactProps {
  name: string;
  path: string;
  retentionDays?: number;
  compressionLevel?: number;
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const UploadArtifact = Composite((props: UploadArtifactProps) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {
    name: props.name,
    path: props.path,
  };
  if (props.retentionDays !== undefined) withObj["retention-days"] = String(props.retentionDays);
  if (props.compressionLevel !== undefined) withObj["compression-level"] = String(props.compressionLevel);

  const step = new Step(mergeDefaults({
    name: "Upload Artifact",
    uses: actionRef("actions/upload-artifact"),
    with: withObj,
  }, defaults?.step));

  return { step };
}, "UploadArtifact");
