# Optional test Lambda (var.enable_lambda = true). Build first: make lambda-zip.
# Stands in for a Lambda -> endpoint -> pooler path.

data "archive_file" "lambda" {
  count = var.enable_lambda ? 1 : 0

  type        = "zip"
  source_dir  = "${path.module}/lambda/dist"
  output_path = "${path.module}/lambda/function.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  count = var.enable_lambda ? 1 : 0

  name               = "supabase-lab-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  count = var.enable_lambda ? 1 : 0

  role       = aws_iam_role.lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_lambda_function" "probe" {
  count = var.enable_lambda ? 1 : 0

  function_name    = "supabase-lab-probe"
  role             = aws_iam_role.lambda[0].arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda[0].output_path
  source_code_hash = data.archive_file.lambda[0].output_base64sha256
  timeout          = 30

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.runner.id]
  }

  environment {
    variables = {
      PGHOST     = local.phz
      PGUSER     = "postgres"
      PGDATABASE = "postgres"
      PGSSLMODE  = "require"
      # In-config on purpose: db_password is already in state via
      # supabase_project, so out-of-band `make lambda-secret` bought no
      # secrecy - and any later apply silently reverted the env to this
      # block, leaving the probe authenticating with no password (run 6).
      PGPASSWORD = var.db_password
    }
  }

  tags = { Name = "supabase-lab" }
}
