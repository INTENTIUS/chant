# Vendored for TF030 from https://github.com/aws-samples/aws-database-acceleration-toolkit
# Path: modules/tffiles-jenkins/jenkins.tf
# Commit: dbb3d2df6a53ef95049e04b7bbe69aa70c607f81
# Licence: MIT-0, https://github.com/aws-samples/aws-database-acceleration-toolkit/blob/dbb3d2df6a53ef95049e04b7bbe69aa70c607f81/LICENSE
# Excerpt: lines 38-65, the aws_security_group.jenkins_port block, unmodified.
#
# TF030: one error, on the second ingress (port 22 from 0.0.0.0/0). The first ingress opens 8080, which is not on the sensitive list, and the egress is not ingress.

resource "aws_security_group" "jenkins_port" {
    vpc_id = var.vpc_id
    provider = aws.primary

    egress {
        from_port = 0
        to_port = 0
        protocol = -1
        cidr_blocks = ["0.0.0.0/0"]
    }    
  

     ingress {
        from_port = 8080
        to_port = 8080
        protocol = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
    } 

       ingress {
        from_port = 22
        to_port = 22
        protocol = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
    } 

    lifecycle { create_before_destroy = true }
}
