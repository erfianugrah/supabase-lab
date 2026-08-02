# In-VPC test runner: stands in for an in-VPC migration runner / psql client. Reachable via SSM only - no public IP, no SSH key, no inbound.
#
# /etc/pvlab.env is written by user_data with everything known at apply time.
# It deliberately does NOT contain the DB password or the Supabase PAT:
# export SUPABASE_ACCESS_TOKEN; the pvlab harness binary is shipped by suite.sh
# inside the SSM session.

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

data "aws_iam_policy_document" "runner_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "runner" {
  name               = "supabase-lab-runner"
  assume_role_policy = data.aws_iam_policy_document.runner_assume.json
}

resource "aws_iam_role_policy_attachment" "runner_ssm" {
  role       = aws_iam_role.runner.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "runner" {
  name = "supabase-lab-runner"
  role = aws_iam_role.runner.name
}

resource "aws_security_group" "runner" {
  name        = "supabase-lab-runner"
  description = "Egress-only: endpoint ports + HTTPS via NAT"
  vpc_id      = aws_vpc.lab.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "supabase-lab-runner" }
}

resource "aws_instance" "runner" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.runner_instance_type
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.runner.id]
  iam_instance_profile   = aws_iam_instance_profile.runner.name

  user_data = templatefile("${path.module}/runner/user-data.sh", {
    ref    = local.ref
    phz    = local.phz
    region = var.aws_region
    phase2 = local.phase2
    ep_dns = local.phase2 ? try(aws_vpc_endpoint.supabase[0].dns_entry[0].dns_name, "") : ""
    ep_ips = local.phase2 ? join(" ", [for eni in data.aws_network_interface.endpoint : eni.private_ip]) : ""
  })

  tags = { Name = "supabase-lab-runner" }
}
