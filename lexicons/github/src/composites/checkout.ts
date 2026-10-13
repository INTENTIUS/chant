import { Composite, mergeDefaults } from "@intentius/chant";
import { Step } from "../generated/index";
import { actionRef, type ActionPinMode } from "../action-pins";

export interface CheckoutProps {
  ref?: string;
  repository?: string;
  fetchDepth?: number;
  token?: string;
  submodules?: boolean | string;
  sshKey?: string;
  /**
   * `"tag"` (default) emits the action's major tag. `"sha"` emits the commit
   * SHA from the lexicon's pin table with the version as a YAML comment, which
   * passes GHA021, GHA029 and GHA059.
   */
  pin?: ActionPinMode;
  defaults?: {
    step?: Partial<ConstructorParameters<typeof Step>[0]>;
  };
}

export const Checkout = Composite((props: CheckoutProps) => {
  const { defaults } = props;
  const withObj: Record<string, string> = {};
  if (props.ref !== undefined) withObj.ref = props.ref;
  if (props.repository !== undefined) withObj.repository = props.repository;
  if (props.fetchDepth !== undefined) withObj["fetch-depth"] = String(props.fetchDepth);
  if (props.token !== undefined) withObj.token = props.token;
  if (props.submodules !== undefined) withObj.submodules = String(props.submodules);
  if (props.sshKey !== undefined) withObj["ssh-key"] = props.sshKey;

  const step = new Step(mergeDefaults({
    name: "Checkout",
    uses: actionRef("actions/checkout", props.pin),
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  }, defaults?.step));

  return { step };
}, "Checkout");
