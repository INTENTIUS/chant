import { Composite, mergeDefaults } from "@intentius/chant";
import { actionRef } from "../action-pins";
import { Step } from "../generated/index";

export interface SetupPythonProps {
  pythonVersion?: string;
  cache?: string;
  architecture?: string;
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const SetupPython = Composite((props: SetupPythonProps) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {};
  if (props.pythonVersion !== undefined) withObj["python-version"] = props.pythonVersion;
  if (props.cache !== undefined) withObj.cache = props.cache;
  if (props.architecture !== undefined) withObj.architecture = props.architecture;

  const step = new Step(mergeDefaults({
    name: "Setup Python",
    uses: actionRef("actions/setup-python"),
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  }, defaults?.step));

  return { step };
}, "SetupPython");
