import { Composite } from "@intentius/chant";

export interface CheckoutProps {
  ref?: string;
  repository?: string;
  fetchDepth?: number;
  token?: string;
  submodules?: boolean | string;
  sshKey?: string;
}

export const Checkout = Composite<CheckoutProps>((props) => {
  const withObj: Record<string, string> = {};
  if (props.ref !== undefined) withObj.ref = props.ref;
  if (props.repository !== undefined) withObj.repository = props.repository;
  if (props.fetchDepth !== undefined) withObj["fetch-depth"] = String(props.fetchDepth);
  if (props.token !== undefined) withObj.token = props.token;
  if (props.submodules !== undefined) withObj.submodules = String(props.submodules);
  if (props.sshKey !== undefined) withObj["ssh-key"] = props.sshKey;

  // Import Step lazily to avoid circular dependency at module load time
  const { createProperty } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const step = new StepClass({
    name: "Checkout",
    uses: "actions/checkout@v4",
    ...(Object.keys(withObj).length > 0 ? { with: withObj } : {}),
  });

  return { step };
}, "Checkout");
