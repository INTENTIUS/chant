import { Composite, mergeDefaults } from "@intentius/chant";
import { Step } from "../generated/index";

export interface CheckoutProps {
  ref?: string;
  repository?: string;
  fetchDepth?: number;
  token?: string;
  submodules?: boolean | string;
  sshKey?: string;
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
    uses: "actions/checkout@v4",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  }, defaults?.step));

  return { step };
}, "Checkout");
