import { Composite } from "@intentius/chant";

export interface SetupNodeProps {
  nodeVersion?: string;
  registryUrl?: string;
  cache?: string;
  cacheFilePath?: string;
}

export const SetupNode = Composite<SetupNodeProps>((props) => {
  const withObj: Record<string, string> = {};
  if (props.nodeVersion !== undefined) withObj["node-version"] = props.nodeVersion;
  if (props.registryUrl !== undefined) withObj["registry-url"] = props.registryUrl;
  if (props.cache !== undefined) withObj.cache = props.cache;
  if (props.cacheFilePath !== undefined) withObj["cache-dependency-path"] = props.cacheFilePath;

  const { createProperty } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const step = new StepClass({
    name: "Setup Node.js",
    uses: "actions/setup-node@v4",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  });

  return { step };
}, "SetupNode");
