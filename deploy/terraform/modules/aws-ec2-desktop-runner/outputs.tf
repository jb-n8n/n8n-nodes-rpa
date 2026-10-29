# Outputs of the aws-ec2-desktop-runner module. None holds a secret: the secrets' ARNs only (Terraform never reads their
# values), and a command that reads the runner's certificate fingerprint, which is public.

locals {
  public_ip = var.elastic_ip ? aws_eip.this[0].public_ip : (var.associate_public_ip ? aws_instance.this.public_ip : null)
  runner_ip = coalesce(local.public_ip, aws_instance.this.private_ip)

  # Prints the newest SHA-256 fingerprint (colon-separated uppercase hex) in %ProgramData%\RPA Runner\logs: the runner's
  # start line in runner-<date>.log, or its captured output, runner.out.log. No recursion: rpa-runner can create folders
  # (and junctions) there, and this runs as SYSTEM.
  fingerprint_ps         = "Get-ChildItem -Path \"$env:ProgramData\\RPA Runner\\logs\\*.log\" -File | Sort-Object LastWriteTime | Select-String -CaseSensitive -Pattern '([0-9A-F]{2}:){31}[0-9A-F]{2}' | Select-Object -Last 1 | ForEach-Object { $_.Matches[0].Value }"
  fingerprint_parameters = replace(jsonencode({ commands = [local.fingerprint_ps] }), "'", "'\\''")
  ssm_target             = "--region ${local.region} --instance-id ${aws_instance.this.id}"
}

output "instance_id" {
  description = "The VM's instance ID."
  value       = aws_instance.this.id
}

output "region" {
  description = "The region the VM runs in."
  value       = local.region
}

output "public_ip" {
  description = "The VM's public IPv4 address at apply time (null without one). Without elastic_ip it changes on every stop and start: desktop-testbed.sh status shows the current one."
  value       = local.public_ip
}

output "private_ip" {
  description = "The VM's private IPv4 address."
  value       = aws_instance.this.private_ip
}

output "runner_url" {
  description = "The runner's WebSocket URL for n8n's RPA Desktop Runner credential (wss://<ip>:<port>/rpa/v1), on the public IP when there is one. Changes with public_ip."
  value       = "wss://${local.runner_ip}:${var.runner_port}/rpa/v1"
}

output "runner_token_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the runner's bearer token (written by the VM on first boot). Read it yourself for the credential; Terraform never does."
  value       = aws_secretsmanager_secret.runner_token.arn
}

output "runner_user_password_secret_arn" {
  description = "ARN of the secret holding the password of the Windows user rpa-runner (auto-logon)."
  value       = aws_secretsmanager_secret.runner_user_password.arn
}

output "admin_password_secret_arn" {
  description = "ARN of the secret holding the built-in Administrator's password, for RDP."
  value       = aws_secretsmanager_secret.admin_password.arn
}

output "fingerprint_command" {
  description = "Shell command (AWS CLI) that prints the runner certificate's SHA-256 fingerprint from the runner's log on the VM, through SSM Run Command. Empty output: the runner hasn't started (or isn't installed) yet."
  value       = "id=$(aws ssm send-command --region ${local.region} --instance-ids ${aws_instance.this.id} --document-name AWS-RunPowerShellScript --comment 'RPA runner fingerprint' --parameters '${local.fingerprint_parameters}' --query Command.CommandId --output text) && aws ssm wait command-executed ${local.ssm_target} --command-id \"$id\" && aws ssm get-command-invocation ${local.ssm_target} --command-id \"$id\" --query StandardOutputContent --output text"
}

output "security_group_id" {
  description = "The VM's security group (runner port and RDP from allowed_cidrs only)."
  value       = aws_security_group.this.id
}

output "vpc_id" {
  description = "The VPC the VM runs in."
  value       = local.vpc_id
}

output "subnet_id" {
  description = "The subnet the VM runs in."
  value       = local.subnet_id
}
