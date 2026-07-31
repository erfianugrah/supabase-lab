# Endpoint security group. Both 5432 AND 6543 inbound - the public setup
# guide's examples are 5432-only (known doc gap, being fixed); 6543 is the
# dedicated pooler and the whole point of the test.
resource "aws_security_group" "endpoint" {
  name        = "supabase-lab-endpoint"
  description = "Inbound to the PrivateLink endpoint: Postgres + pooler"
  vpc_id      = aws_vpc.lab.id

  ingress {
    description = "Postgres direct"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.lab.cidr_block]
  }

  ingress {
    description = "Dedicated pooler (PgBouncer, transaction mode)"
    from_port   = 6543
    to_port     = 6543
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.lab.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "supabase-lab-endpoint" }
}

# The RAM share must be accepted before the resource configuration becomes
# visible (list-resources is empty while PENDING), so acceptance happens in
# `make arns` - a declarative aws_ram_resource_share_accepter cannot work
# here: it needs a PENDING invitation, but phase 2 only runs after the ARNs
# exist, i.e. after acceptance. arns.tfvars presence is the gate.
resource "aws_vpc_endpoint" "supabase" {
  count = local.phase2 ? 1 : 0

  vpc_id                     = aws_vpc.lab.id
  vpc_endpoint_type          = "Resource"
  resource_configuration_arn = var.resource_configuration_arn
  subnet_ids                 = aws_subnet.private[*].id
  security_group_ids         = [aws_security_group.endpoint.id]
  ip_address_type            = "ipv4"

  tags = { Name = "supabase-lab-privatelink" }
}

data "aws_network_interface" "endpoint" {
  for_each = local.phase2 ? toset(aws_vpc_endpoint.supabase[0].network_interface_ids) : toset([])

  id = each.key
}

# Route53 private hosted zone for db.<ref>.supabase.co - keeps
# sslmode=verify-full working through the endpoint (the endpoint's own DNS
# name is never in the project certificate). This is the DNS answer both the
# Lambda path and the migration runner use.
#
# NOTE: the zone apex cannot be a CNAME, so the apex A record carries the
# endpoint ENI addresses directly. TTL 60 so endpoint changes propagate fast.
resource "aws_route53_zone" "db" {
  name = local.phz

  vpc {
    vpc_id = aws_vpc.lab.id
  }

  tags = { Name = "supabase-lab" }
}

resource "aws_route53_record" "db" {
  count = local.phase2 ? 1 : 0

  zone_id = aws_route53_zone.db.zone_id
  name    = local.phz
  type    = "A"
  ttl     = 60
  records = [for eni in data.aws_network_interface.endpoint : eni.private_ip]
}
