# Four secrets, created empty. The VM fills them on its first boot (setup.ps1.tftpl) with secretsmanager:PutSecretValue.
# So no value is ever in a Terraform plan, the state, an output or the user data, and the instance role can write
# these secrets but never read them back. Read them yourself (desktop-testbed.sh rdp-password, or the AWS CLI);
# Terraform never does.
#
# - admin_password: the built-in Administrator's password, for RDP. The VM makes it with the OS's cryptographic RNG
#   and writes it here before it sets it.
# - runner_user_password: the password of the local user rpa-runner, which signs in automatically. The VM makes it the
#   same way, writes it here, and then hands it to the installer, which creates the user with it and stores it for
#   automatic sign-in (Windows keeps it as the LSA secret DefaultPassword, not in the registry). Nobody needs it
#   unless automatic sign-in is replaced. Written only when package_url is set.
# - runner_token and browser_token: the bearer tokens n8n's RPA Desktop Runner and RPA Browser credentials send. The
#   installer makes them (%ProgramData%\RPA Runner\token and browser-token, readable by SYSTEM, Administrators and
#   rpa-runner only); the first boot copies them here after the install. Written only when package_url is set.

resource "aws_secretsmanager_secret" "runner_token" {
  name_prefix             = "${var.name}-runner-token-"
  description             = "Bearer token of the RPA desktop runner on ${var.name}; written by the VM on first boot."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "browser_token" {
  name_prefix             = "${var.name}-browser-token-"
  description             = "Bearer token of the RPA browser on ${var.name}; written by the VM on first boot."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "runner_user_password" {
  name_prefix             = "${var.name}-runner-user-password-"
  description             = "Password of the Windows user rpa-runner on ${var.name} (automatic sign-in); written by the VM on first boot."
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
