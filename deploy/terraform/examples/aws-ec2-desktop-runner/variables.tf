variable "aws_region" {
  description = "AWS region for the test bed, for example us-west-2."
  type        = string
}

variable "allowed_cidrs" {
  description = "Required: the CIDRs that may reach the runner (8765) and RDP (3389), usually your own public IPv4 as a /32 (curl -s https://checkip.amazonaws.com). The module refuses 0.0.0.0/0."
  type        = list(string)
}

variable "name" {
  description = "Name of the VM and prefix of its resources."
  type        = string
  default     = "rpa-desktop-testbed"
}

variable "instance_type" {
  description = "EC2 instance type (x86_64)."
  type        = string
  default     = "t3.large"
}

variable "elastic_ip" {
  description = "Keep the same public IP across stop and start (an Elastic IP, billed while stopped too)."
  type        = bool
  default     = false
}

variable "runner_artifact_url" {
  description = "HTTPS URL of the rpa-desktop release zip (or a zip with RpaRunner.exe, or the .exe). Empty: no runner yet; install one later with desktop-testbed.sh install-runner."
  type        = string
  default     = ""
}

variable "runner_artifact_sha256" {
  description = "SHA-256 of the runner build at runner_artifact_url. Empty: not checked."
  type        = string
  default     = ""
}
