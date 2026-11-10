# Inputs of the aws-ec2-desktop-runner module. No input carries a secret: the VM makes the Windows passwords on its
# first boot, the product's installer makes the two tokens, and the VM writes all four to Secrets Manager itself, so
# they never enter the plan or state.

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
  description = "Required. The only CIDRs that may reach the runner port, the browser port and RDP (3389), for example [\"203.0.113.7/32\"]. The security group lets in these only; it is the test bed's limit, because the installer's Windows Firewall rules on the VM let the two ports in from any address. Changing the list updates the security group in place and does not replace the VM. Never the whole internet: 0.0.0.0/0, ::/0 and any range wider than /16 (IPv4) or /48 (IPv6) are refused."
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
    error_message = "allowed_cidrs must not open the runner, the browser or RDP to the internet: 0.0.0.0/0, ::/0 and ranges wider than /16 (IPv4) or /48 (IPv6) are refused (a /8 can hold other AWS customers)."
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
  description = "Give the VM a public IPv4 address. The runner and browser URLs use it. It changes on every stop and start unless elastic_ip is true. False only with a subnet_id whose route reaches SSM another way."
  type        = bool
  default     = true
}

variable "elastic_ip" {
  description = "Attach an Elastic IP so the runner and browser URLs survive stop and start. AWS charges for it while the VM is stopped as well (public IPv4 pricing)."
  type        = bool
  default     = false
}

variable "enable_rdp" {
  description = "Open RDP (3389) to allowed_cidrs. SSM works without it; RDP is for watching the desktop as Administrator (a second session that leaves the bot user's console session alone)."
  type        = bool
  default     = true
}

variable "runner_port" {
  description = "TCP port the runner listens on (wss://<ip>:<port>/rpa/v1), passed to the installer as -RunnerPort. The installer's default is 8765. With a package, changing it replaces the VM."
  type        = number
  default     = 8765

  validation {
    condition     = var.runner_port >= 1024 && var.runner_port <= 65535 && floor(var.runner_port) == var.runner_port && var.runner_port != 3389
    error_message = "runner_port must be a whole number from 1024 to 65535, other than 3389."
  }
}

variable "browser_port" {
  description = "TCP port the RPA browser listens on (wss://<ip>:<port>), passed to the installer as -BrowserPort. The installer's default is 3000. With a package, changing it replaces the VM."
  type        = number
  default     = 3000

  validation {
    condition     = var.browser_port >= 1024 && var.browser_port <= 65535 && floor(var.browser_port) == var.browser_port && var.browser_port != 3389
    error_message = "browser_port must be a whole number from 1024 to 65535, other than 3389."
  }
  validation {
    condition     = var.browser_port != var.runner_port
    error_message = "browser_port and runner_port must differ: each program needs its own port."
  }
}

variable "package_url" {
  description = "HTTPS URL of the RPA Windows package (rpa-windows-x64.zip). The first boot downloads it, checks package_sha256, unpacks it and runs its Install-Rpa.ps1. Empty (with package_sha256 empty too): the VM gets the test-bed setup only and nothing of the product is installed. The URL is stored in the instance's user data and in state, so use a public release asset or a short-lived pre-signed URL, never one with a long-lived credential in it. Changing it replaces the VM; desktop-testbed.sh install upgrades without that."
  type        = string
  default     = ""

  validation {
    # RFC 3986's characters without the single quote: the same test as desktop-testbed.sh and the script on the VM.
    condition     = var.package_url == "" || can(regex("^https://[A-Za-z0-9._~:/?#\\[\\]@!$&()*+,;=%-]+$", var.package_url))
    error_message = "package_url must be empty or an https:// URL of plain URL characters, without spaces or quotes."
  }
  # Both or neither. Both rules are here, not one on each variable: two variables that validate each other are a cycle.
  validation {
    condition     = var.package_url == "" || var.package_sha256 != ""
    error_message = "package_url needs package_sha256: the VM compares the download with it before it unpacks or runs anything."
  }
  validation {
    condition     = var.package_url != "" || var.package_sha256 == ""
    error_message = "package_sha256 is set without package_url: set both, or neither."
  }
}

variable "package_sha256" {
  description = "SHA-256 of the file at package_url (64 hex characters). Required with package_url: the VM refuses a download that does not match, before it unpacks or runs anything from it."
  type        = string
  default     = ""

  validation {
    condition     = var.package_sha256 == "" || can(regex("^[0-9A-Fa-f]{64}$", var.package_sha256))
    error_message = "package_sha256 must be empty or 64 hexadecimal characters."
  }
}

variable "runner_policy" {
  description = "What the runner's policy gets on top of the installer's starter policy (which allows no app), when package_url is set: the first boot writes it as a change file and applies it with the package's RpaPolicy.exe. Each allowedApps entry pins the absolute local path that runs; sha256 pins its hash, allowedArgs lists the exact argument lists a launch may pass (none without it), allowUserWritable (default false) permits a path the bot user could change. The default allows the ERP Demo (v1) that the package installs, with --ui v1 or --ui v2, and gates its Post button, the OK/Save button (automation id 1) of every common dialog it owns, such as its Export Save dialog, and Ctrl+S / F11. The file size limit (maxFileBytes) is not part of it: RpaPolicy.exe does not change that limit, so it stays at the installer's default, and a maxFileBytes given here is ignored."
  type = object({
    allowedApps = list(object({
      exe               = string
      path              = string
      sha256            = optional(string)
      allowedArgs       = optional(list(list(string)))
      allowUserWritable = optional(bool)
    }))
    writeControls = optional(list(object({
      exe          = string
      automationId = string
    })), [])
    gatedKeys = optional(list(string), [])
  })
  default = {
    allowedApps = [{
      exe         = "ErpDemo.exe"
      path        = "C:\\Program Files\\RPA Runner\\erp-demo\\v1\\ErpDemo.exe"
      allowedArgs = [["--ui", "v1"], ["--ui", "v2"]]
    }]
    writeControls = [{ exe = "ErpDemo.exe", automationId = "btnPost" }, { exe = "ErpDemo.exe", automationId = "1" }]
    gatedKeys     = ["Ctrl+S", "F11"]
  }

  validation {
    condition = alltrue([
      for a in var.runner_policy.allowedApps :
      can(regex("^[A-Za-z]:\\\\", a.path)) && endswith(lower(a.path), "\\${lower(a.exe)}") && can(regex("^[A-Za-z0-9][A-Za-z0-9 ._-]*\\.exe$", a.exe))
    ])
    error_message = "Each runner_policy.allowedApps entry needs exe (a file name such as App.exe) and path, an absolute local path (C:\\...) ending in that file name; UNC and device paths are refused."
  }
  validation {
    condition     = alltrue([for a in var.runner_policy.allowedApps : a.sha256 == null || can(regex("^[0-9A-Fa-f]{64}$", coalesce(a.sha256, "-")))])
    error_message = "runner_policy.allowedApps[].sha256 must be 64 hexadecimal characters."
  }
  # The limits RpaPolicy.exe puts on a change, checked here so that a plan fails and not a first boot.
  validation {
    condition = (
      length(var.runner_policy.allowedApps) + length(flatten([for a in var.runner_policy.allowedApps : [for l in coalesce(a.allowedArgs, []) : 1]])) +
      length(var.runner_policy.writeControls) + length(var.runner_policy.gatedKeys)
    ) <= 40
    error_message = "runner_policy may hold at most 40 entries: allowedApps, their allowedArgs lists, writeControls and gatedKeys together (the limit RpaPolicy.exe has for one change)."
  }
  validation {
    condition = alltrue(flatten([
      [for a in var.runner_policy.allowedApps : [length(a.exe) <= 260, length(a.path) <= 260, [for l in coalesce(a.allowedArgs, []) : [length(l) <= 20, [for v in l : length(v) <= 260]]]]],
      [for w in var.runner_policy.writeControls : [length(w.exe) <= 260, length(w.automationId) <= 260]],
    ]))
    error_message = "runner_policy: a name, path, id or argument may be at most 260 characters, and an allowedArgs list may hold at most 20 arguments (the limits RpaPolicy.exe has for a change)."
  }
  validation {
    condition     = alltrue([for a in var.runner_policy.allowedApps : !can(regex("~[0-9]", a.path))])
    error_message = "runner_policy.allowedApps[].path must be the full path, not a short (8.3) name such as C:\\PROGRA~1 (RpaPolicy.exe refuses one)."
  }
}


variable "secret_recovery_window_days" {
  description = "Recovery window of the four secrets on destroy: 0 deletes them at once, 7 to 30 keeps them restorable that long."
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
