# Non-secret experiment config - committed. Secrets live in ../../secrets.tfvars
# (decrypt with `make secrets-decrypt` at the repo root).

aws_region           = "ap-southeast-1"
project_name         = "lab-privatelink"
instance_size        = "micro"
runner_instance_type = "t3.micro"
enable_lambda        = true
public_access_cidrs  = ["0.0.0.0/0", "::/0"]
