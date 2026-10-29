# Inputs of the aws-ec2-desktop-runner module. No input carries a secret: the VM generates the runner token and the
# Windows passwords on its first boot and writes them to Secrets Manager itself, so they never enter the plan or state.

variable "name" {
  description = "Name of the VM and prefix of every resource (security group, role, secrets). 2 to 32 characters."
  type        = string
  default     = "rpa-desktop-testbed"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,30}[a-z0-9]$", var.name))
    error_message = "name must be 2 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen."
  }
}

variable "allowed_cidrs" {
  description = "Required. The only CIDRs that may reach the runner port and RDP (3389), for example [\"203.0.113.7/32\"]. Never the whole internet: 0.0.0.0/0, ::/0 and any range wider than /16 (IPv4) or /48 (IPv6) are refused."
  type        = list(string)

  validation {
    condition     = length(var.allowed_cidrs) > 0 && alltrue([for c in var.allowed_cidrs : can(cidrhost(c, 0)) && strcontains(c, "/")])
    error_message = "allowed_cidrs must list at least one CIDR with a prefix length, for example 203.0.113.7/32."
  }
  validation {
    condition = alltrue([
      for c in var.allowed_cidrs :
      try(strcontains(c, ":") ? tonumber(split("/", c)[1]) >= 48 : tonumber(split("/", c)[1]) >= 16, false)
    ])
    error_message = "allowed_cidrs must not open the runner or RDP to the internet: 0.0.0.0/0, ::/0 and ranges wider than /16 (IPv4) or /48 (IPv6) are refused (a /8 can hold other AWS customers)."
  }
  validation {
    condition     = alltrue([for c in var.allowed_cidrs : try(lower(cidrsubnet(c, 0, 0)) == lower(c), false)])
    error_message = "allowed_cidrs must be network addresses with no host bits set (203.0.113.0/24, not 203.0.113.7/24; IPv6 in its shortest form)."
  }
}

variable "instance_type" {
  description = "EC2 instance type, x86_64 (Windows Server has no Arm AMI on EC2). t3.large (2 vCPU, 8 GiB) runs Windows Server 2022 with a WinForms app comfortably."
  type        = string
  default     = "t3.large"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.instance_type)) && !can(regex("^[a-z]+[0-9]+[a-z]*g[a-z]*\\.", var.instance_type))
    error_message = "instance_type must be an x86_64 instance type such as t3.large; Graviton (Arm) types like t4g or m7g can't run Windows Server."
  }
}

variable "cpu_credits" {
  description = "CPU credit mode for burstable types (t2, t3, t3a): unlimited (AWS's default for t3; charges only for sustained use above the baseline) or standard (throttles to the baseline instead, which makes Windows' first boot slow). Ignored for other types."
  type        = string
  default     = "unlimited"

  validation {
    condition     = contains(["standard", "unlimited"], var.cpu_credits)
    error_message = "cpu_credits must be standard or unlimited."
  }
}

variable "ami_ssm_parameter" {
  description = "Public SSM parameter that names the AMI. The default is the latest Windows Server 2022 English Full (with Desktop Experience) AMI. The instance ignores later AMI changes; replace it to move to a newer one."
  type        = string
  default     = "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base"

  validation {
    condition     = startswith(var.ami_ssm_parameter, "/aws/service/ami-windows-latest/Windows_Server-")
    error_message = "ami_ssm_parameter must be one of AWS's public Windows AMI parameters (/aws/service/ami-windows-latest/Windows_Server-...)."
  }
}

variable "root_volume_size_gb" {
  description = "Size of the encrypted gp3 root volume in GiB (30 to 1024)."
  type        = number
  default     = 50

  validation {
    condition     = var.root_volume_size_gb >= 30 && var.root_volume_size_gb <= 1024 && floor(var.root_volume_size_gb) == var.root_volume_size_gb
    error_message = "root_volume_size_gb must be a whole number from 30 to 1024."
  }
}

variable "kms_key_arn" {
  description = "Customer managed KMS key for the root volume and the secrets. Null: the AWS managed keys (aws/ebs, aws/secretsmanager). With a key, the role gets kms:GenerateDataKey on it through Secrets Manager (what PutSecretValue needs); the key policy must allow that, and allow EC2 to use the key for EBS."
  type        = string
  default     = null

  validation {
    condition     = var.kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/.+$", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>)."
  }
}

variable "subnet_id" {
  description = "An existing subnet for the VM. It needs a route to the internet (or VPC endpoints for SSM, EC2 messages and Secrets Manager) for SSM and the first-boot setup. Null: use_default_vpc decides."
  type        = string
  default     = null

  validation {
    condition     = var.subnet_id == null || can(regex("^subnet-[0-9a-f]+$", var.subnet_id))
    error_message = "subnet_id must be a subnet ID (subnet-...)."
  }
}

variable "use_default_vpc" {
  description = "When subnet_id is null: true puts the VM in a default subnet of the region's default VPC; false (default) creates a minimal VPC with one public subnet and an internet gateway."
  type        = bool
  default     = false
}

variable "vpc_cidr" {
  description = "CIDR of the VPC the module creates (subnet_id null, use_default_vpc false). The public subnet takes its lower half."
  type        = string
  default     = "10.90.0.0/24"

  validation {
    condition     = try(cidrhost(var.vpc_cidr, 0) != "" && !strcontains(var.vpc_cidr, ":") && tonumber(split("/", var.vpc_cidr)[1]) >= 16 && tonumber(split("/", var.vpc_cidr)[1]) <= 27, false)
    error_message = "vpc_cidr must be an IPv4 CIDR from /16 to /27."
  }
}

variable "availability_zone" {
  description = "Availability Zone for the subnet the module creates, or to pick among the default VPC's subnets. Null: the first zone (by name) that offers instance_type."
  type        = string
  default     = null
}

variable "associate_public_ip" {
  description = "Give the VM a public IPv4 address. The runner URL uses it. It changes on every stop and start unless elastic_ip is true. False only with a subnet_id whose route reaches SSM another way."
  type        = bool
  default     = true
}

variable "elastic_ip" {
  description = "Attach an Elastic IP so the runner URL survives stop and start. AWS charges for it while the VM is stopped as well (public IPv4 pricing)."
  type        = bool
  default     = false
}

variable "enable_rdp" {
  description = "Open RDP (3389) to allowed_cidrs. SSM works without it; RDP is for watching the desktop as Administrator (a second session that leaves the runner user's console session alone)."
  type        = bool
  default     = true
}

variable "runner_port" {
  description = "TCP port the runner listens on (wss://<ip>:<port>/rpa/v1). The runner's default is 8765."
  type        = number
  default     = 8765

  validation {
    condition     = var.runner_port >= 1024 && var.runner_port <= 65535 && floor(var.runner_port) == var.runner_port && var.runner_port != 3389
    error_message = "runner_port must be a whole number from 1024 to 65535, other than 3389."
  }
}

variable "runner_artifact_url" {
  description = "HTTPS URL of the runner build: a zip of the self-contained win-x64 publish, or the single executable. Empty: the VM is prepared without a runner (install one later with install-runner.ps1 over SSM). The URL is stored in the instance's user data and in state, so use a public release asset or a short-lived pre-signed URL, never one with a long-lived credential in it. Changing it replaces the VM."
  type        = string
  default     = ""

  validation {
    condition     = var.runner_artifact_url == "" || can(regex("^https://[^\\s'\"`]+$", var.runner_artifact_url))
    error_message = "runner_artifact_url must be empty or an https:// URL without spaces or quotes."
  }
}

variable "runner_artifact_sha256" {
  description = "SHA-256 of the file at runner_artifact_url (64 hex characters). When set, the VM refuses a download that doesn't match. Empty: not checked."
  type        = string
  default     = ""

  validation {
    condition     = var.runner_artifact_sha256 == "" || can(regex("^[0-9A-Fa-f]{64}$", var.runner_artifact_sha256))
    error_message = "runner_artifact_sha256 must be empty or 64 hexadecimal characters."
  }
}

variable "runner_executable" {
  description = "File name of the runner executable inside the artifact."
  type        = string
  default     = "rpa-desktop-runner.exe"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*\\.exe$", var.runner_executable))
    error_message = "runner_executable must be a plain .exe file name (letters, digits, dot, underscore, hyphen)."
  }
}

variable "runner_arguments" {
  description = "Command-line arguments for the runner. The start script also sets RPA_RUNNER_TOKEN_FILE, RPA_RUNNER_PORT and RPA_RUNNER_POLICY_FILE in its environment. Never put the token here."
  type        = list(string)
  default     = []
}

variable "runner_policy" {
  description = "The runner's local policy, written to %ProgramData%\\RPA Runner\\policy.json (administrators may change it, the runner user may only read it). The default allows the demo app ErpDemo.exe and gates its Post button and Ctrl+S / F11."
  type = object({
    allowedApps = list(object({ exe = string }))
    writeControls = optional(list(object({
      exe          = string
      automationId = string
    })), [])
    gatedKeys    = optional(list(string), [])
    maxFileBytes = optional(number, 20971520)
  })
  default = {
    allowedApps   = [{ exe = "ErpDemo.exe" }]
    writeControls = [{ exe = "ErpDemo.exe", automationId = "btnPost" }]
    gatedKeys     = ["Ctrl+S", "F11"]
    maxFileBytes  = 20971520
  }

  validation {
    condition     = var.runner_policy.maxFileBytes >= 1 && floor(var.runner_policy.maxFileBytes) == var.runner_policy.maxFileBytes
    error_message = "runner_policy.maxFileBytes must be a positive whole number."
  }
}

variable "secret_recovery_window_days" {
  description = "Recovery window of the three secrets on destroy: 0 deletes them at once, 7 to 30 keeps them restorable that long."
  type        = number
  default     = 7

  validation {
    condition     = var.secret_recovery_window_days == 0 || (var.secret_recovery_window_days >= 7 && var.secret_recovery_window_days <= 30 && floor(var.secret_recovery_window_days) == var.secret_recovery_window_days)
    error_message = "secret_recovery_window_days must be 0 or a whole number from 7 to 30."
  }
}

variable "tags" {
  description = "More tags for every resource. Project = n8n-rpa-desktop-testbed is always added and wins over a Project key here."
  type        = map(string)
  default     = {}
}
