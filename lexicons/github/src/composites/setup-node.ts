import { Composite, mergeDefaults } from "@intentius/chant";
import { Step } from "../generated/index";

export interface SetupNodeProps {
  nodeVersion?: string;
  registryUrl?: string;
  cache?: string;
  cacheFilePath?: string;
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const SetupNode = Composite<SetupNodeProps>((props) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {};
  if (props.nodeVersion !== undefined) withObj["node-version"] = props.nodeVersion;
  if (props.registryUrl !== undefined) withObj["registry-url"] = props.registryUrl;
  if (props.cache !== undefined) withObj.cache = props.cache;
  if (props.cacheFilePath !== undefined) withObj["cache-dependency-path"] = props.cacheFilePath;

  const step = new Step(mergeDefaults({
    name: "Setup Node.js",
    uses: "actions/setup-node@v4",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  }, defaults?.step));

  return { step };
}, "SetupNode");
