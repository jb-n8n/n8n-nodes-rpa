output "instance_id" {
  description = "The VM's instance ID."
  value       = module.desktop_runner.instance_id
}

output "region" {
  description = "The region the VM runs in."
  value       = module.desktop_runner.region
}

output "public_ip" {
  description = "The VM's public IPv4 address at apply time; it changes on stop and start unless elastic_ip is true."
  value       = module.desktop_runner.public_ip
}

output "runner_url" {
  description = "The runner's URL for the RPA Desktop Runner credential (at apply time; desktop-testbed.sh status shows the current one)."
  value       = module.desktop_runner.runner_url
}

output "runner_token_secret_arn" {
  description = "ARN of the secret with the runner's bearer token (never the token itself)."
  value       = module.desktop_runner.runner_token_secret_arn
}

output "runner_user_password_secret_arn" {
  description = "ARN of the secret with rpa-runner's password."
  value       = module.desktop_runner.runner_user_password_secret_arn
}

output "admin_password_secret_arn" {
  description = "ARN of the secret with the Administrator's password (desktop-testbed.sh rdp-password copies it)."
  value       = module.desktop_runner.admin_password_secret_arn
}

output "fingerprint_command" {
  description = "AWS CLI command that prints the runner certificate's fingerprint (or desktop-testbed.sh fingerprint)."
  value       = module.desktop_runner.fingerprint_command
}
