import { Composite, mergeDefaults } from "@intentius/chant";
import { Step } from "../generated/index";

export interface SetupGoProps {
  goVersion?: string;
  goVersionFile?: string;
  cache?: boolean;
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const SetupGo = Composite((props: SetupGoProps) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {};
  if (props.goVersion !== undefined) withObj["go-version"] = props.goVersion;
  if (props.goVersionFile !== undefined) withObj["go-version-file"] = props.goVersionFile;
  if (props.cache !== undefined) withObj.cache = String(props.cache);

  const step = new Step(mergeDefaults({
    name: "Setup Go",
    uses: "actions/setup-go@v5",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  }, defaults?.step));

  return { step };
}, "SetupGo");
