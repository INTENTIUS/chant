import { Composite, mergeDefaults } from "@intentius/chant";
import { Role, InstanceProfile } from "../generated";
import { Ref } from "../intrinsics";

export interface Ec2InstanceRoleProps {
  ManagedPolicyArns?: string[];
  Policies?: ConstructorParameters<typeof Role>[0]["Policies"];
  defaults?: {
    role?: Partial<ConstructorParameters<typeof Role>[0]>;
    instanceProfile?: Partial<ConstructorParameters<typeof InstanceProfile>[0]>;
  };
}

const EC2_ASSUME_ROLE = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

export const Ec2InstanceRole = Composite<Ec2InstanceRoleProps>((props) => {
  const { defaults } = props;

  const role = new Role(mergeDefaults({
    AssumeRolePolicyDocument: EC2_ASSUME_ROLE,
    ManagedPolicyArns: props.ManagedPolicyArns ?? [],
    Policies: props.Policies ?? [],
  }, defaults?.role));

  const instanceProfile = new InstanceProfile(mergeDefaults({
    Roles: [Ref(role)],
  }, defaults?.instanceProfile));

  return { role, instanceProfile };
}, "Ec2InstanceRole");
