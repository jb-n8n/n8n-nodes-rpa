# A Windows Server 2022 VM for the RPA desktop runner: a dedicated low-privilege user (rpa-runner) signs in on the
# console automatically, and the runner starts in that interactive session at logon, so it can drive desktop apps.
# The first-boot setup is user-data.ps1.tftpl; network.tf places the VM, secrets.tf holds the secrets it generates.

locals {
  tags   = merge(var.tags, { Project = "n8n-rpa-desktop-testbed" })
  region = data.aws_region.current.region

  burstable = can(regex("^t[23]a?\\.", var.instance_type))

  # EC2 takes at most 16 KB of user data, so the setup script travels gzipped, without its full-line comments (the files
  # here keep them), inside a small bootstrap.
  user_data      = templatefile("${path.module}/user-data.ps1.tftpl", { setup = base64gzip(local.setup) })
  user_data_size = length(local.user_data)
  setup          = replace(local.setup_full, "/(?m)^[ \\t]*#.*\\n/", "")
  setup_full = templatefile("${path.module}/setup.ps1.tftpl", {
    region                          = base64encode(local.region)
    runner_token_secret_arn         = base64encode(aws_secretsmanager_secret.runner_token.arn)
    runner_user_password_secret_arn = base64encode(aws_secretsmanager_secret.runner_user_password.arn)
    admin_password_secret_arn       = base64encode(aws_secretsmanager_secret.admin_password.arn)
    runner_artifact_url             = base64encode(var.runner_artifact_url)
    runner_artifact_sha256          = base64encode(var.runner_artifact_sha256)
    runner_config                   = base64encode(jsonencode({ exe = var.runner_executable, args = var.runner_arguments, port = var.runner_port }))
    runner_policy                   = base64encode(jsonencode(var.runner_policy))
    runner_port                     = var.runner_port
    start_runner_ps1                = chomp(file("${path.module}/scripts/start-runner.ps1"))
    install_runner_ps1              = chomp(file("${path.module}/scripts/install-runner.ps1"))
  })
}

data "aws_region" "current" {}

data "aws_partition" "current" {}

data "aws_ssm_parameter" "ami" {
  name = var.ami_ssm_parameter
}

# --- Instance role: SSM management, and writing (never reading) the three secrets.

resource "aws_iam_role" "this" {
  name_prefix = "${var.name}-"
  description = "RPA desktop runner test bed VM (${var.name}): SSM, and writing its own secrets on first boot"
  tags        = local.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "secrets" {
  name = "write-own-secrets"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid    = "WriteOwnSecrets"
        Effect = "Allow"
        Action = "secretsmanager:PutSecretValue"
        Resource = [
          aws_secretsmanager_secret.runner_token.arn,
          aws_secretsmanager_secret.runner_user_password.arn,
          aws_secretsmanager_secret.admin_password.arn,
        ]
      }],
      var.kms_key_arn == null ? [] : [{
        Sid       = "EncryptOwnSecrets"
        Effect    = "Allow"
        Action    = "kms:GenerateDataKey"
        Resource  = var.kms_key_arn
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${local.region}.amazonaws.com" } }
      }],
    )
  })
}

resource "aws_iam_instance_profile" "this" {
  name_prefix = "${var.name}-"
  role        = aws_iam_role.this.name
  tags        = local.tags
}

# --- The VM.

resource "aws_instance" "this" {
  ami                         = data.aws_ssm_parameter.ami.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.this.id]
  associate_public_ip_address = var.associate_public_ip
  iam_instance_profile        = aws_iam_instance_profile.this.name
  monitoring                  = false
  get_password_data           = false

  # Runs once, on the first boot. A changed input (runner URL, policy, port) replaces the VM so the setup runs again;
  # install-runner.ps1 over SSM updates the runner without that.
  user_data                   = local.user_data
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    http_protocol_ipv6          = "disabled"
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    kms_key_id            = var.kms_key_arn
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = var.name })
  }

  dynamic "credit_specification" {
    for_each = local.burstable ? [var.cpu_credits] : []
    content {
      cpu_credits = credit_specification.value
    }
  }

  tags = merge(local.tags, { Name = var.name })

  # The first boot needs the role's permissions and, in the module's own VPC, the route to the internet.
  depends_on = [
    aws_iam_role_policy.secrets,
    aws_iam_role_policy_attachment.ssm,
    aws_route.internet,
    aws_route_table_association.public,
  ]

  lifecycle {
    # A newer AMI behind the SSM parameter must not replace a running test bed; replace it on purpose
    # (terraform apply -replace=...) to move to one.
    ignore_changes = [ami]

    precondition {
      condition     = local.user_data_size <= 16384
      error_message = "The user data is over EC2's 16 KB limit; shorten runner_policy or runner_arguments."
    }
    precondition {
      condition     = !local.create_vpc || local.zone != null
      error_message = "No Availability Zone in this region offers ${var.instance_type}; choose another instance_type."
    }
    precondition {
      condition     = local.subnet_id != null
      error_message = "The default VPC has no default subnet in a zone that offers ${var.instance_type}; set availability_zone or subnet_id."
    }
    precondition {
      condition     = !local.create_vpc || var.associate_public_ip
      error_message = "The module's own VPC reaches SSM and Secrets Manager only through its internet gateway, so associate_public_ip must stay true."
    }
  }
}

# Optional: a fixed public address across stop and start.
resource "aws_eip" "this" {
  count = var.elastic_ip ? 1 : 0

  domain   = "vpc"
  instance = aws_instance.this.id
  tags     = merge(local.tags, { Name = var.name })
}
