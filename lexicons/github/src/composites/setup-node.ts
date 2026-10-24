import { Composite, mergeDefaults } from "@intentius/chant";
import { Step } from "../generated/index";
import { actionRef, type ActionPinMode } from "../action-pins";

export interface SetupNodeProps {
  nodeVersion?: string;
  registryUrl?: string;
  cache?: string;
  cacheFilePath?: string;
  /**
   * `"sha"` (default) emits the commit SHA from the pin table with the version as
   * a YAML comment, which passes GHA021, GHA029 and GHA059. `"tag"` emits the
   * action's major tag.
   */
  pin?: ActionPinMode;
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const SetupNode = Composite((props: SetupNodeProps) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {};
  if (props.nodeVersion !== undefined) withObj["node-version"] = props.nodeVersion;
  if (props.registryUrl !== undefined) withObj["registry-url"] = props.registryUrl;
  if (props.cache !== undefined) withObj.cache = props.cache;
  if (props.cacheFilePath !== undefined) withObj["cache-dependency-path"] = props.cacheFilePath;

  const step = new Step(mergeDefaults({
    name: "Setup Node.js",
    uses: actionRef("actions/setup-node", props.pin ?? "sha"),
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  }, defaults?.step));

  return { step };
}, "SetupNode");
