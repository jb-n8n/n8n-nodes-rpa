variable "aws_region" {
  description = "AWS region for the test bed, for example us-west-2."
  type        = string
}

variable "allowed_cidrs" {
  description = "Required: the CIDRs that may reach the runner (8765), the browser (3000) and RDP (3389), usually your own public IPv4 as a /32 (curl -s https://checkip.amazonaws.com). The module refuses 0.0.0.0/0."
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

variable "package_url" {
  description = "HTTPS URL of the RPA Windows package (rpa-windows-x64.zip), installed on the first boot. Empty: nothing of the product is installed. It is stored in the user data and the state: use a public release asset or a short-lived pre-signed URL."
  type        = string
  default     = ""
}

variable "package_sha256" {
  description = "SHA-256 of the file at package_url (64 hex characters). Required with package_url; the VM checks the download against it before it unpacks or runs anything."
  type        = string
  default     = ""
}
