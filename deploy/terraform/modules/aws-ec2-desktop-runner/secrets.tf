# Three secrets, created empty. The VM fills them on its first boot (user-data.ps1.tftpl): it generates each value with
# the OS's cryptographic RNG, writes it here with secretsmanager:PutSecretValue, and only then uses it. So no value is
# ever in a Terraform plan, the state, an output or the user data, and the instance role can write these secrets but
# never read them back. Read them yourself (desktop-testbed.sh rdp-password, or the AWS CLI); Terraform never does.
#
# - runner_token: the bearer token n8n's RPA Desktop Runner credential sends. On the VM it is also in
#   %ProgramData%\RPA Runner\token, readable by SYSTEM, Administrators and the runner user only.
# - runner_user_password: the password of the local user rpa-runner, which signs in automatically. On the VM Windows
#   keeps it as the LSA secret DefaultPassword (not in the registry); nobody needs it unless auto-logon is replaced.
# - admin_password: the built-in Administrator's password, for RDP.

resource "aws_secretsmanager_secret" "runner_token" {
  name_prefix             = "${var.name}-runner-token-"
  description             = "Bearer token of the RPA desktop runner on ${var.name}; written by the VM on first boot."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "runner_user_password" {
  name_prefix             = "${var.name}-runner-user-password-"
  description             = "Password of the Windows user rpa-runner on ${var.name} (auto-logon); written by the VM on first boot."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "admin_password" {
  name_prefix             = "${var.name}-admin-password-"
  description             = "Password of the built-in Administrator on ${var.name} (RDP); written by the VM on first boot."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = local.tags
}
