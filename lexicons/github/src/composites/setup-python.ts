import { Composite } from "@intentius/chant";

export interface SetupPythonProps {
  pythonVersion?: string;
  cache?: string;
  architecture?: string;
}

export const SetupPython = Composite<SetupPythonProps>((props) => {
  const withObj: Record<string, string> = {};
  if (props.pythonVersion !== undefined) withObj["python-version"] = props.pythonVersion;
  if (props.cache !== undefined) withObj.cache = props.cache;
  if (props.architecture !== undefined) withObj.architecture = props.architecture;

  const { createProperty } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const step = new StepClass({
    name: "Setup Python",
    uses: "actions/setup-python@v5",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  });

  return { step };
}, "SetupPython");
