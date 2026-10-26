# The gate token. Unless existing_token_secret_arn is set, the module generates it and writes it to a
# new Secrets Manager secret without the value ever entering the plan or the state:
# - ephemeral "random_password" produces it during each plan and apply and is never stored;
# - secret_string_wo is a write-only argument: the provider sends it to AWS and keeps nothing;
# - secret_string_wo_version is a plain integer, so the value is written once, when the version is created. The
#   password generated on later runs is thrown away. To rotate, change the 1 to 2 (or rotate in Secrets Manager and
#   restart the tasks). It is a literal on purpose: an ephemeral value there is refused (hashicorp/terraform-provider-aws#44590).
# The ECS task reads the secret through the container's secrets.valueFrom; outputs give only its ARN.

locals {
  generate_token   = var.existing_token_secret_arn == null
  token_secret_arn = local.generate_token ? aws_secretsmanager_secret.token[0].arn : var.existing_token_secret_arn
}

ephemeral "random_password" "token" {
  count = local.generate_token ? 1 : 0

  # 48 letters and digits (about 285 bits): no character a shell, a URL or a header needs escaped.
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "token" {
  count = local.generate_token ? 1 : 0

  name_prefix = "${var.name}-token-"
  description = "Token of the RPA browser gate (${var.name}); the RPA Browser credential in n8n uses the same value."
  kms_key_id  = var.token_kms_key_arn
  tags        = var.tags
}

resource "aws_secretsmanager_secret_version" "token" {
  count = local.generate_token ? 1 : 0

  secret_id                = aws_secretsmanager_secret.token[0].id
  secret_string_wo         = ephemeral.random_password.token[0].result
  secret_string_wo_version = 1
}
