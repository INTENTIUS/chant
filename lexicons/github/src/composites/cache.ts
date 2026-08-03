import { Composite, mergeDefaults } from "@intentius/chant";
import { Step } from "../generated/index";

export interface CacheActionProps {
  path: string;
  key: string;
  restoreKeys?: string[];
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const CacheAction = Composite((props: CacheActionProps) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {
    path: props.path,
    key: props.key,
  };
  if (props.restoreKeys !== undefined) withObj["restore-keys"] = props.restoreKeys.join("\n");

  const step = new Step(mergeDefaults({
    name: "Cache",
    uses: "actions/cache@v4",
    with: withObj,
  }, defaults?.step));

  return { step };
}, "Cache");
