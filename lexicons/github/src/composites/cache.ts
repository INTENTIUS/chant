import { Composite } from "@intentius/chant";

export interface CacheActionProps {
  path: string;
  key: string;
  restoreKeys?: string[];
}

export const CacheAction = Composite<CacheActionProps>((props) => {
  const withObj: Record<string, string> = {
    path: props.path,
    key: props.key,
  };
  if (props.restoreKeys !== undefined) withObj["restore-keys"] = props.restoreKeys.join("\n");

  const { createProperty } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const step = new StepClass({
    name: "Cache",
    uses: "actions/cache@v4",
    with: withObj,
  });

  return { step };
}, "Cache");
