import { Composite, mergeDefaults } from "@intentius/chant";
import type { Step } from "../generated/index";

export interface SetupGoProps {
  goVersion?: string;
  goVersionFile?: string;
  cache?: boolean;
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const SetupGo = Composite<SetupGoProps>((props) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {};
  if (props.goVersion !== undefined) withObj["go-version"] = props.goVersion;
  if (props.goVersionFile !== undefined) withObj["go-version-file"] = props.goVersionFile;
  if (props.cache !== undefined) withObj.cache = String(props.cache);

  const { createProperty } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const step = new StepClass(mergeDefaults({
    name: "Setup Go",
    uses: "actions/setup-go@v5",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  }, defaults?.step));

  return { step };
}, "SetupGo");
