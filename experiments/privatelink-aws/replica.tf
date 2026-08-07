# T28 - a second consumer endpoint for the read replica's OWN Lattice
# resource configuration, IF it turns out the replica gets one (T28's first
# question, checked live against AWS RAM by the test itself). Same phase-2
# gating shape as aws_vpc_endpoint.supabase in lattice.tf: the ARN is unknown
# until the replica exists and its RAM share has been accepted, so this
# stays at count=0 until BOTH the toggle is on and that ARN has been
# supplied - a live run would add a `make arns-replica` step, the same shape
# as the existing `make arns`, once this is exercised.
#
# Off by default (enable_read_replica) - see variables.tf for why.
resource "aws_vpc_endpoint" "read_replica" {
  count = var.enable_read_replica && var.replica_resource_configuration_arn != "" ? 1 : 0

  vpc_id                     = aws_vpc.lab.id
  vpc_endpoint_type          = "Resource"
  resource_configuration_arn = var.replica_resource_configuration_arn
  subnet_ids                 = aws_subnet.private[*].id
  security_group_ids         = [aws_security_group.endpoint.id]
  ip_address_type            = "ipv4"

  tags = { Name = "supabase-lab-privatelink-replica" }
}
