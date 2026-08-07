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

# T25 - the VPC Lattice SERVICE NETWORK consumption path, as an alternative
# to the direct Resource endpoint above. AWS's pricing page quotes a roughly
# 5x per-resource-hour delta for this path over the endpoint-hours already
# running in this lab - cited from pricing documentation, never built. Off
# by default (enable_service_network): it bills that second rate on top of
# the endpoint for as long as it exists.
resource "aws_vpclattice_service_network" "supabase" {
  count = var.enable_service_network ? 1 : 0

  name = "supabase-lab-network"

  tags = { Name = "supabase-lab" }
}

# The lab VPC, so the SAME runner that already answers T02 can answer T25
# too - the question is which consumption path works, not which VPC.
resource "aws_vpclattice_service_network_vpc_association" "lab" {
  count = var.enable_service_network ? 1 : 0

  vpc_identifier             = aws_vpc.lab.id
  service_network_identifier = aws_vpclattice_service_network.supabase[0].id
  security_group_ids         = [aws_security_group.endpoint.id]

  tags = { Name = "supabase-lab" }
}

# Needs phase 2 for the resource configuration ARN to exist - the same gate
# the direct endpoint above uses. Its dns_entry is a computed attribute; T25
# reads the domain name from it rather than guessing a naming scheme.
resource "aws_vpclattice_service_network_resource_association" "supabase" {
  count = var.enable_service_network && local.phase2 ? 1 : 0

  resource_configuration_identifier = var.resource_configuration_arn
  service_network_identifier        = aws_vpclattice_service_network.supabase[0].id

  tags = { Name = "supabase-lab" }
}
