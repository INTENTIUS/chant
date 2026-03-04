import { Composite } from "@intentius/chant";

export interface SetupGoProps {
  goVersion?: string;
  goVersionFile?: string;
  cache?: boolean;
}

export const SetupGo = Composite<SetupGoProps>((props) => {
  const withObj: Record<string, string> = {};
  if (props.goVersion !== undefined) withObj["go-version"] = props.goVersion;
  if (props.goVersionFile !== undefined) withObj["go-version-file"] = props.goVersionFile;
  if (props.cache !== undefined) withObj.cache = String(props.cache);

  const { createProperty } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const step = new StepClass({
    name: "Setup Go",
    uses: "actions/setup-go@v5",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  });

  return { step };
}, "SetupGo");
