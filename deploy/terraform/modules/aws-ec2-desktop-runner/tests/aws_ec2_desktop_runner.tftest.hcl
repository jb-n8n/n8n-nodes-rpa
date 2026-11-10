# terraform test for the aws-ec2-desktop-runner module: plan-only runs against a mocked AWS provider, so no AWS account
# is needed. override_during = plan makes the overridden computed values (IDs, ARNs, addresses) known at plan, so the
# assertions can compare rules, policies, the user data and the outputs with real strings.

mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_region.current
    values = {
      region = "us-west-2"
    }
  }
  override_data {
    target = data.aws_partition.current
    values = {
      partition = "aws"
    }
  }
  override_data {
    target = data.aws_ssm_parameter.ami
    values = {
      insecure_value = "ami-0123456789abcdef0"
    }
  }
  override_data {
    target = data.aws_ec2_instance_type_offerings.this
    values = {
      locations = ["us-west-2c", "us-west-2a", "us-west-2b"]
    }
  }
  override_data {
    target = data.aws_vpc.default
    values = {
      id = "vpc-0dddddddddddddddd"
    }
  }
  override_data {
    target = data.aws_subnets.default
    values = {
      ids = ["subnet-0dddddddddddddd02", "subnet-0dddddddddddddd01"]
    }
  }
  override_data {
    target = data.aws_subnet.given
    values = {
      vpc_id = "vpc-0eeeeeeeeeeeeeeee"
    }
  }
  override_resource {
    target = aws_vpc.this
    values = {
      id = "vpc-0aaaaaaaaaaaaaaaa"
    }
  }
  override_resource {
    target = aws_subnet.public
    values = {
      id = "subnet-0aaaaaaaaaaaaaaaa"
    }
  }
  override_resource {
    target = aws_security_group.this
    values = {
      id = "sg-0aaaaaaaaaaaaaaaa"
    }
  }
  override_resource {
    target = aws_secretsmanager_secret.runner_token
    values = {
      arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-token-AbCdEf"
    }
  }
  override_resource {
    target = aws_secretsmanager_secret.browser_token
    values = {
      arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-browser-token-StUvWx"
    }
  }
  override_resource {
    target = aws_secretsmanager_secret.runner_user_password
    values = {
      arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-user-password-GhIjKl"
    }
  }
  override_resource {
    target = aws_secretsmanager_secret.admin_password
    values = {
      arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-admin-password-MnOpQr"
    }
  }
  override_resource {
    target = aws_iam_role.this
    values = {
      arn  = "arn:aws:iam::123456789012:role/rpa-desktop-testbed-0001"
      name = "rpa-desktop-testbed-0001"
    }
  }
  override_resource {
    target = aws_instance.this
    values = {
      id         = "i-0123456789abcdef0"
      public_ip  = "203.0.113.50"
      private_ip = "10.90.0.10"
    }
  }
  override_resource {
    target = aws_eip.this
    values = {
      public_ip = "198.51.100.77"
    }
  }
}

variables {
  allowed_cidrs = ["203.0.113.7/32", "198.51.100.0/24"]
}

run "runner_browser_and_rdp_only_from_allowed_cidrs" {
  command = plan

  assert {
    condition = toset(keys(aws_vpc_security_group_ingress_rule.allowed)) == toset([
      "runner 203.0.113.7/32", "runner 198.51.100.0/24", "browser 203.0.113.7/32", "browser 198.51.100.0/24",
      "rdp 203.0.113.7/32", "rdp 198.51.100.0/24",
    ])
    error_message = "One ingress rule per port (runner, browser, RDP) and allowed CIDR, nothing more."
  }
  assert {
    condition = alltrue([
      for k, r in aws_vpc_security_group_ingress_rule.allowed :
      r.security_group_id == "sg-0aaaaaaaaaaaaaaaa" && r.ip_protocol == "tcp" && r.from_port == r.to_port &&
      r.from_port == { runner = 8765, browser = 3000, rdp = 3389 }[split(" ", k)[0]] && r.cidr_ipv4 == split(" ", k)[1] && r.cidr_ipv6 == null
    ])
    error_message = "Ingress is TCP 8765, 3000 or 3389, a single port, from the rule's own CIDR."
  }
  assert {
    condition     = toset(keys(aws_vpc_security_group_egress_rule.web)) == toset(["80", "443"]) && alltrue([for k, r in aws_vpc_security_group_egress_rule.web : r.ip_protocol == "tcp" && r.from_port == tonumber(k) && r.to_port == tonumber(k)])
    error_message = "Egress is TCP 80 and 443 only."
  }
  assert {
    # A structural guard: the security group rules are these two resources, with no inline or legacy rules anywhere.
    condition = (
      toset([for m in regexall("resource \"(aws_vpc_security_group_(?:ingress|egress)_rule)\" \"([a-z0-9_]+)\"", file("${path.module}/network.tf")) : "${m[0]}.${m[1]}"]) == toset(["aws_vpc_security_group_ingress_rule.allowed", "aws_vpc_security_group_egress_rule.web"]) &&
      !can(regex("aws_security_group_rule|egress\\s*\\{|ingress\\s*\\{|ip_protocol\\s*=\\s*\"-1\"", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")])))
    )
    error_message = "network.tf may declare only the allowed ingress and web egress rules; no inline, legacy or all-protocol rules."
  }
  assert {
    # Adopted with no rule blocks, so the provider removes every rule from it.
    condition     = length(aws_default_security_group.this) == 1 && aws_default_security_group.this[0].vpc_id == "vpc-0aaaaaaaaaaaaaaaa"
    error_message = "The module's own VPC has its default security group adopted and emptied."
  }
}

run "the_vm_is_hardened" {
  command = plan

  assert {
    condition = (
      aws_instance.this.metadata_options[0].http_tokens == "required" &&
      aws_instance.this.metadata_options[0].http_put_response_hop_limit == 1 &&
      aws_instance.this.metadata_options[0].http_protocol_ipv6 == "disabled" &&
      aws_instance.this.metadata_options[0].instance_metadata_tags == "disabled"
    )
    error_message = "IMDSv2 only, one hop, no IPv6 endpoint, no tags in metadata."
  }
  assert {
    condition = (
      aws_instance.this.root_block_device[0].encrypted == true && aws_instance.this.root_block_device[0].volume_type == "gp3" &&
      aws_instance.this.root_block_device[0].volume_size == 50 && aws_instance.this.root_block_device[0].delete_on_termination == true
    )
    error_message = "The root volume is encrypted gp3, 50 GiB, deleted with the VM."
  }
  assert {
    condition     = aws_instance.this.ami == "ami-0123456789abcdef0" && aws_instance.this.instance_type == "t3.large" && aws_instance.this.get_password_data == false
    error_message = "The AMI comes from the SSM parameter; t3.large by default; no EC2 password data (no key pair)."
  }
  assert {
    condition     = aws_instance.this.credit_specification[0].cpu_credits == "unlimited"
    error_message = "t3 gets the credit mode from cpu_credits."
  }
  assert {
    condition     = aws_instance.this.tags["Project"] == "n8n-rpa-desktop-testbed" && aws_secretsmanager_secret.runner_token.tags["Project"] == "n8n-rpa-desktop-testbed" && aws_vpc.this[0].tags["Project"] == "n8n-rpa-desktop-testbed"
    error_message = "Every resource carries Project = n8n-rpa-desktop-testbed."
  }
  assert {
    condition     = aws_instance.this.subnet_id == "subnet-0aaaaaaaaaaaaaaaa" && aws_subnet.public[0].availability_zone == "us-west-2a" && aws_subnet.public[0].cidr_block == "10.90.0.0/25"
    error_message = "By default the VM runs in the module's own public subnet, in the first zone that offers the type."
  }
  assert {
    condition     = aws_route.internet[0].destination_cidr_block == "0.0.0.0/0" && aws_instance.this.associate_public_ip_address == true
    error_message = "The module's own subnet routes to the internet gateway and the VM has a public IP (SSM needs both)."
  }
}

run "the_role_can_write_its_secrets_but_never_read_them" {
  command = plan

  assert {
    condition     = aws_iam_role_policy_attachment.ssm.policy_arn == "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    error_message = "The role has AmazonSSMManagedInstanceCore."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.secrets.policy).Statement == [{
      Sid    = "WriteOwnSecrets"
      Effect = "Allow"
      Action = "secretsmanager:PutSecretValue"
      Resource = [
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-token-AbCdEf",
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-browser-token-StUvWx",
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-user-password-GhIjKl",
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-admin-password-MnOpQr",
      ]
    }]
    error_message = "The inline policy allows exactly PutSecretValue on the four secrets: no read, no wildcard."
  }
  assert {
    condition     = jsondecode(aws_iam_role.this.assume_role_policy).Statement[0].Principal == { Service = "ec2.amazonaws.com" }
    error_message = "Only EC2 assumes the role."
  }
}

run "without_a_package_the_user_data_installs_nothing_of_the_product" {
  command = plan

  assert {
    # 16384 is EC2's limit; the setup leaves room for a long policy and a pre-signed URL.
    condition     = local.user_data_size <= 10240 && startswith(local.user_data, "<powershell>") && endswith(trimspace(local.user_data), "</powershell>")
    error_message = "The user data is one PowerShell block of at most 10 KB by default."
  }
  assert {
    condition     = strcontains(local.user_data, "FromBase64String('${base64gzip(local.setup)}')") && !strcontains(local.setup, "\n#") && startswith(local.setup_full, "#")
    error_message = "The user data carries the setup script gzipped, without its comment lines."
  }
  assert {
    condition = alltrue([for v in [
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-admin-password-MnOpQr",
      "us-west-2",
    ] : strcontains(local.setup, "'${base64encode(v)}'")])
    error_message = "The Administrator password's secret ARN and the region reach the VM base64-encoded."
  }
  assert {
    condition = alltrue([
      for text in ["& $InstallPackage", "$PackageUrl", "$PackageSha", "RpaPolicy.exe", "ReadAllText(", "shutdown.exe"] :
      !strcontains(local.setup, text)
    ])
    error_message = "Without package_url the first boot downloads nothing, installs nothing, reads no token and does not restart."
  }
  assert {
    condition     = strcontains(local.setup, "Set-LocalUser -Password") && strcontains(local.setup, "Set-NetFirewallProfile -All -Enabled True") && strcontains(local.setup, "Set-Content -LiteralPath $Done")
    error_message = "The test-bed setup still runs: the Administrator password, Windows Firewall on, the done marker."
  }
  assert {
    # desktop-testbed.sh status asks whether setup.failed is there; it does not read setup.log.
    condition     = strcontains(local.setup, "$Failed         = Join-Path $Root 'setup.failed'") && strcontains(local.setup, "trap { Set-Content -LiteralPath $Failed -Value (Get-Date -Format o); Log ('setup FAILED at line")
    error_message = "A failed setup writes the marker setup.failed before its log line."
  }
  assert {
    condition = (
      strcontains(local.setup, "New-NetFirewallRule -Name 'RPA-TestBed-No-IMDS' -DisplayName 'Block instance metadata for members of Users' -Direction Outbound -Protocol TCP -RemoteAddress '169.254.169.254' -LocalUser 'D:(A;;CC;;;BU)' -Action Block") &&
      strcontains(local.setup, "wevtutil.exe') sl 'Microsoft-Windows-PowerShell/Operational' '/ca:O:BAG:SYD:(A;;0xf0007;;;SY)(A;;0x7;;;BA)'")
    )
    error_message = "Without a package too: the instance metadata address is blocked for every member of Users, and the Windows PowerShell event log is for SYSTEM and Administrators only."
  }
  assert {
    condition     = aws_instance.this.user_data_replace_on_change == true
    error_message = "A changed setup replaces the VM, since user data runs only on the first boot."
  }
}

run "the_first_boot_leaves_the_install_to_the_installer" {
  command = plan

  variables {
    package_url    = "https://example.com/releases/download/v1/rpa-windows-x64.zip"
    package_sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  assert {
    # What Install-Rpa.ps1 does now: the user, automatic sign-in, the no-lock settings, the data directory and its
    # access rules, the tokens, the inbound firewall rules, the scheduled tasks, the start scripts.
    condition = alltrue([
      for text in [
        "New-LocalUser", "Add-LocalGroupMember", "LsaStorePrivateData", "AutoAdminLogon", "DefaultPassword", "NoLockScreen", "powercfg",
        "icacls", "policy.json", "runner.json", "RPA-Runner-In", "RPA-Browser-In", "New-ScheduledTask", "Register-ScheduledTask",
        "Start-Process", "AsPlainText",
      ] : !strcontains(local.setup, text)
    ])
    error_message = "The first boot creates no user, sets up no sign-in, sets no access rules on the data directory, adds no inbound rule and registers no task: the installer does."
  }
  assert {
    condition = (
      strcontains(local.setup, "& $InstallPackage -Url $PackageUrl -Sha256 $PackageSha -User $User -UserPassword $secure -RunnerPort $RunnerPort -BrowserPort $BrowserPort |") &&
      strcontains(local.setup, "& $installer -User $User -UserPassword $UserPassword -RunnerPort $RunnerPort -BrowserPort $BrowserPort -AllowFromAnyAddress -IncludePublicNetwork -AutoSignIn -Force *>&1") &&
      !strcontains(local.setup, "-AllowFrom ")
    )
    error_message = "The first boot hands the package, the user, its password and the ports to install-package.ps1, which calls Install-Rpa.ps1 with -User, -UserPassword, -AllowFromAnyAddress -IncludePublicNetwork (the security group limits the addresses), -AutoSignIn and -Force."
  }
  assert {
    condition     = length(split("ReadAllText(", local.setup)) == 2 && strcontains(split("ReadAllText(", local.setup)[0], "& $InstallPackage -Url $PackageUrl") && strcontains(split("ReadAllText(", local.setup)[1], "Save-Secret $arn $value")
    error_message = "The two token files are read in one place, after the install, and go to Secrets Manager only."
  }
  assert {
    condition = (
      strcontains(split("$secure = New-StoredPassword $AdminPwArn", local.setup)[0], "New-NetFirewallRule -Name 'RPA-TestBed-No-IMDS' -DisplayName 'Block instance metadata for members of Users' -Direction Outbound -Protocol TCP -RemoteAddress '169.254.169.254' -LocalUser 'D:(A;;CC;;;BU)' -Action Block") &&
      strcontains(split("New-NetFirewallRule -Name 'RPA-TestBed-No-IMDS' -DisplayName 'Block instance metadata for members of Users' -Direction Outbound -Protocol TCP -RemoteAddress '169.254.169.254' -LocalUser 'D:(A;;CC;;;BU)' -Action Block", local.setup)[0], "Set-NetFirewallProfile -All -Enabled True") &&
      strcontains(split("Set-Content -LiteralPath $InstallPackage", local.setup)[0], "wevtutil.exe') sl 'Microsoft-Windows-PowerShell/Operational' '/ca:O:BAG:SYD:(A;;0xf0007;;;SY)(A;;0x7;;;BA)'")
    )
    error_message = "Before any secret write and anything of the product: Windows Firewall on, the instance metadata address blocked for every member of Users, and the Windows PowerShell event log for SYSTEM and Administrators only."
  }
  assert {
    # In install-package.ps1 (embedded): the rule for the bot user by its SID, straight after the installer returns in
    # both modes, before the script decides whether the install was good.
    condition = (
      strcontains(split("& $installer @upgrade *>&1", local.setup)[1], "Set-MetadataBlock $botUser") &&
      strcontains(split("Set-MetadataBlock $botUser", local.setup)[1], "if (-not $script:installed) { throw \"Install-Rpa.ps1 did not finish") &&
      strcontains(local.setup, "New-NetFirewallRule -Name 'RPA-Runner-No-IMDS' -DisplayName 'Block instance metadata for the RPA bot user' -Direction Outbound -Protocol TCP -RemoteAddress '169.254.169.254' -LocalUser \"D:(A;;CC;;;$sid)\" -Action Block") &&
      strcontains(local.setup, "Set-NetFirewallRule -Name 'RPA-Runner-No-IMDS' -Protocol TCP -RemoteAddress '169.254.169.254' -LocalUser \"D:(A;;CC;;;$sid)\" -Action Block -Enabled True")
    )
    error_message = "install-package.ps1 adds or updates the bot user's instance metadata block after the installer returns, for a first install and for an upgrade."
  }
  assert {
    condition = (
      strcontains(split("& $InstallPackage -Url $PackageUrl", local.setup)[1], "'y' | & $tool apply $change --yes 2>&1") &&
      strcontains(local.setup, "shutdown.exe") && strcontains(local.setup, "Set-Content -LiteralPath $Done")
    )
    error_message = "After the install the policy change goes through RpaPolicy.exe (--yes, and y on standard input); then the done marker and the restart."
  }
}

run "the_package_reaches_the_vm" {
  command = plan

  variables {
    package_url    = "https://bucket.s3.us-west-2.amazonaws.com/rpa-windows-x64.zip?X-Amz-Expires=3600&X-Amz-Signature=0a1b2c"
    package_sha256 = "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
    browser_port   = 3443
  }

  assert {
    condition = alltrue([for v in [
      "https://bucket.s3.us-west-2.amazonaws.com/rpa-windows-x64.zip?X-Amz-Expires=3600&X-Amz-Signature=0a1b2c",
      "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
      jsonencode({ allowedApps = [{ allowedArgs = [["--ui", "v1"], ["--ui", "v2"]], exe = "ErpDemo.exe", path = "C:\\Program Files\\RPA Runner\\erp-demo\\v1\\ErpDemo.exe" }], gatedKeys = ["Ctrl+S", "F11"], writeControls = [{ automationId = "btnPost", exe = "ErpDemo.exe" }, { automationId = "1", exe = "ErpDemo.exe" }] }),
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-token-AbCdEf",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-browser-token-StUvWx",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-user-password-GhIjKl",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-admin-password-MnOpQr",
      "us-west-2",
    ] : strcontains(local.setup, "'${base64encode(v)}'")])
    error_message = "The package URL and hash, the policy change, the secret ARNs and the region reach the VM base64-encoded."
  }
  assert {
    condition     = strcontains(local.setup, "$RunnerPort   = [int]'8765'") && strcontains(local.setup, "$BrowserPort  = [int]'3443'")
    error_message = "The two ports reach the VM."
  }
  assert {
    # The hash is compared before the zip is opened, and the installer runs only after both.
    condition = (
      strcontains(split("ZipFile]::OpenRead(", local.setup)[0], "if ($hash -ne $Sha256.ToUpperInvariant()) { throw") &&
      strcontains(split("ZipFile]::OpenRead(", local.setup)[0], "Invoke-WebRequest -Uri $Url") &&
      length(split("ZipFile]::OpenRead(", local.setup)) == 2 &&
      !strcontains(split("ZipFile]::OpenRead(", local.setup)[0], "& $installer")
    )
    error_message = "install-package.ps1 downloads, compares the SHA-256 and only then opens the zip and runs the installer."
  }
  assert {
    condition     = !strcontains(local.setup, "$env:TEMP") && !strcontains(local.setup, "GetTempPath") && strcontains(local.setup, "'O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'")
    error_message = "The package is downloaded and unpacked in a folder made for SYSTEM and Administrators only, never under a temp folder."
  }
  assert {
    # No secret: passwords are made on the VM, the tokens by the installer; nothing of them goes to a log or to output.
    condition = (
      strcontains(local.setup, "New-Secret 32") && strcontains(local.setup, "-notmatch 'rpa|runner|admin'") && !strcontains(local.setup, "ShowTokens") &&
      length(regexall("(Log|Say|Write-Output|Write-Host|Add-Content|Set-Content)[^\\n]*\\$(plain|value|secure|UserPassword)\\b", local.setup)) == 0
    )
    error_message = "The user data holds no secret, passwords avoid the account names (Windows refuses a password that holds one), and the setup writes no password or token to a log, a file or its output."
  }
  assert {
    condition     = local.user_data_size <= 12288
    error_message = "The user data stays well under EC2's 16 KB with a package and a pre-signed URL."
  }
}

run "a_change_of_allowed_cidrs_does_not_change_the_user_data" {
  command = plan

  variables {
    allowed_cidrs  = ["192.0.2.0/24", "2001:db8:77::/48"]
    package_url    = "https://example.com/releases/download/v1/rpa-windows-x64.zip"
    package_sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  assert {
    # The setup rendered here from everything it may depend on. allowed_cidrs is not among these inputs, so two plans
    # that differ only in it have the same user data, and the VM is not replaced.
    condition = local.setup_full == templatefile("${path.module}/setup.ps1.tftpl", {
      region                          = base64encode("us-west-2")
      runner_token_secret_arn         = base64encode("arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-token-AbCdEf")
      browser_token_secret_arn        = base64encode("arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-browser-token-StUvWx")
      runner_user_password_secret_arn = base64encode("arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-user-password-GhIjKl")
      admin_password_secret_arn       = base64encode("arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-admin-password-MnOpQr")
      install_package                 = true
      package_url                     = base64encode("https://example.com/releases/download/v1/rpa-windows-x64.zip")
      package_sha256                  = base64encode("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
      policy_change                   = base64encode(local.policy_change_json)
      runner_port                     = 8765
      browser_port                    = 3000
      install_package_ps1             = chomp(file("${path.module}/scripts/install-package.ps1"))
    })
    error_message = "The setup script depends only on the region, the secret ARNs, the package, the policy and the two ports."
  }
  assert {
    condition     = local.user_data == templatefile("${path.module}/user-data.ps1.tftpl", { setup = base64gzip(replace(local.setup_full, "/(?m)^[ \\t]*#.*\\n/", "")) })
    error_message = "The user data is that setup script, gzipped, and nothing else."
  }
  assert {
    condition = alltrue([
      for text in ["192.0.2", "2001:db8:77", base64encode("192.0.2.0/24,2001:db8:77::/48"), base64encode("192.0.2.0/24"), "AllowFrom $", "allow_from"] :
      !strcontains(local.setup_full, text) && !strcontains(file("${path.module}/setup.ps1.tftpl"), text)
    ])
    error_message = "No allowed CIDR is in the setup script, encoded or not, and the template has no input for one."
  }
  assert {
    condition     = toset(keys(aws_vpc_security_group_ingress_rule.allowed)) == toset(flatten([for p in ["runner", "browser", "rdp"] : [for c in var.allowed_cidrs : "${p} ${c}"]]))
    error_message = "The changed CIDRs are in the security group's rules."
  }
}

run "the_install_script_and_the_installer_agree_on_the_success_line" {
  command = plan

  assert {
    # install-package.ps1 reads the installer's output for this exact line, because the installer's exit code does not
    # say that it finished when it runs inside another PowerShell.
    condition = (
      length(regexall("(?m)^Write-Host 'RPA is installed\\.'\r?$", file("${path.module}/../../../../desktop/installer/Install-Rpa.ps1"))) == 1 &&
      strcontains(file("${path.module}/scripts/install-package.ps1"), "if ($text -ceq 'RPA is installed.') { $script:installed = $true }")
    )
    error_message = "desktop/installer/Install-Rpa.ps1 must print exactly 'RPA is installed.' once, as its own line, when it has finished: install-package.ps1 takes that line as success. Change both together."
  }
}

run "outputs_give_url_arns_and_the_fingerprint_command" {
  command = plan

  assert {
    condition     = output.runner_url == "wss://203.0.113.50:8765/rpa/v1" && output.browser_url == "wss://203.0.113.50:3000" && output.public_ip == "203.0.113.50" && output.instance_id == "i-0123456789abcdef0" && output.region == "us-west-2"
    error_message = "runner_url is wss://<public IP>:8765/rpa/v1 and browser_url is wss://<public IP>:3000."
  }
  assert {
    condition = (
      output.runner_token_secret_arn == "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-token-AbCdEf" &&
      output.browser_token_secret_arn == "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-browser-token-StUvWx" &&
      output.runner_user_password_secret_arn == "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-user-password-GhIjKl" &&
      output.admin_password_secret_arn == "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-admin-password-MnOpQr"
    )
    error_message = "The secrets come out as ARNs."
  }
  assert {
    condition = (
      strcontains(output.fingerprint_command, "aws ssm send-command --region us-west-2 --instance-ids i-0123456789abcdef0 --document-name AWS-RunPowerShellScript") &&
      strcontains(output.fingerprint_command, "aws ssm get-command-invocation --region us-west-2 --instance-id i-0123456789abcdef0") &&
      strcontains(output.fingerprint_command, "\\u0026 '\\''C:\\\\Program Files\\\\RPA Runner\\\\scripts\\\\Show-RpaConnection.ps1'\\'' | Where-Object { $_ -match '\\'' fingerprint: '\\'' }") &&
      !strcontains(output.fingerprint_command, "ShowTokens")
    )
    error_message = "fingerprint_command runs Show-RpaConnection.ps1 through SSM and keeps its two fingerprint lines, never with -ShowTokens, with the single quotes escaped for the shell (jsonencode writes & as \\u0026)."
  }
}

run "rdp_can_be_closed" {
  command = plan

  variables {
    enable_rdp = false
  }

  assert {
    condition     = toset(keys(aws_vpc_security_group_ingress_rule.allowed)) == toset(["runner 203.0.113.7/32", "runner 198.51.100.0/24", "browser 203.0.113.7/32", "browser 198.51.100.0/24"])
    error_message = "enable_rdp = false leaves only the runner and browser ports."
  }
}

run "browser_port_only_from_allowed_cidrs" {
  command = plan

  variables {
    allowed_cidrs = ["203.0.113.7/32", "2001:db8:1234::/48"]
    browser_port  = 3443
    enable_rdp    = false
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.allowed["browser 203.0.113.7/32"].from_port == 3443 &&
      aws_vpc_security_group_ingress_rule.allowed["browser 203.0.113.7/32"].to_port == 3443 &&
      aws_vpc_security_group_ingress_rule.allowed["browser 203.0.113.7/32"].cidr_ipv4 == "203.0.113.7/32" &&
      aws_vpc_security_group_ingress_rule.allowed["browser 2001:db8:1234::/48"].from_port == 3443 &&
      aws_vpc_security_group_ingress_rule.allowed["browser 2001:db8:1234::/48"].cidr_ipv6 == "2001:db8:1234::/48" &&
      aws_vpc_security_group_ingress_rule.allowed["browser 2001:db8:1234::/48"].cidr_ipv4 == null
    )
    error_message = "browser_port is opened as one TCP port to each allowed CIDR."
  }
  assert {
    condition     = [for k, r in aws_vpc_security_group_ingress_rule.allowed : k if r.from_port == 3443 || r.to_port == 3443] == ["browser 2001:db8:1234::/48", "browser 203.0.113.7/32"]
    error_message = "No other rule opens browser_port: only the allowed CIDRs reach it."
  }
  assert {
    condition     = output.browser_url == "wss://203.0.113.50:3443"
    error_message = "browser_url follows browser_port."
  }
}

run "ipv6_cidrs_and_another_port" {
  command = plan

  variables {
    allowed_cidrs = ["2001:db8:1234::/48"]
    runner_port   = 9443
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.allowed["runner 2001:db8:1234::/48"].cidr_ipv6 == "2001:db8:1234::/48" && aws_vpc_security_group_ingress_rule.allowed["runner 2001:db8:1234::/48"].cidr_ipv4 == null && aws_vpc_security_group_ingress_rule.allowed["runner 2001:db8:1234::/48"].from_port == 9443
    error_message = "An IPv6 CIDR becomes a cidr_ipv6 rule on runner_port."
  }
  assert {
    condition     = output.runner_url == "wss://203.0.113.50:9443/rpa/v1"
    error_message = "runner_url follows runner_port."
  }
}

run "default_vpc" {
  command = plan

  variables {
    use_default_vpc = true
  }

  assert {
    condition     = length(aws_vpc.this) == 0 && length(aws_internet_gateway.this) == 0 && length(aws_subnet.public) == 0
    error_message = "use_default_vpc creates no network."
  }
  assert {
    condition     = aws_instance.this.subnet_id == "subnet-0dddddddddddddd01" && aws_security_group.this.vpc_id == "vpc-0dddddddddddddddd"
    error_message = "The VM goes into the default VPC's first default subnet (by ID) in a zone that offers the type."
  }
}

run "existing_subnet" {
  command = plan

  variables {
    subnet_id           = "subnet-0123456789abcdef0"
    associate_public_ip = false
  }

  assert {
    condition     = length(aws_vpc.this) == 0 && aws_instance.this.subnet_id == "subnet-0123456789abcdef0" && aws_security_group.this.vpc_id == "vpc-0eeeeeeeeeeeeeeee"
    error_message = "subnet_id puts the VM and its security group in that subnet's VPC."
  }
  assert {
    condition     = output.runner_url == "wss://10.90.0.10:8765/rpa/v1"
    error_message = "Without a public IP the runner URL uses the private IP."
  }
}

run "elastic_ip_and_kms_key" {
  command = plan

  variables {
    elastic_ip  = true
    kms_key_arn = "arn:aws:kms:us-west-2:123456789012:key/0f0f0f0f-1111-2222-3333-444444444444"
  }

  assert {
    condition     = length(aws_eip.this) == 1 && output.runner_url == "wss://198.51.100.77:8765/rpa/v1"
    error_message = "elastic_ip attaches an EIP and the URL uses it."
  }
  assert {
    condition     = aws_instance.this.root_block_device[0].kms_key_id == var.kms_key_arn && aws_secretsmanager_secret.admin_password.kms_key_id == var.kms_key_arn
    error_message = "The key encrypts the volume and the secrets."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.secrets.policy).Statement[1] == {
      Sid       = "EncryptOwnSecrets"
      Effect    = "Allow"
      Action    = "kms:GenerateDataKey"
      Resource  = "arn:aws:kms:us-west-2:123456789012:key/0f0f0f0f-1111-2222-3333-444444444444"
      Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.us-west-2.amazonaws.com" } }
    }
    error_message = "With a key, the role may only generate data keys through Secrets Manager."
  }
}

run "non_burstable_type_has_no_credit_specification" {
  command = plan

  variables {
    instance_type = "m6i.large"
  }

  assert {
    condition     = length(aws_instance.this.credit_specification) == 0
    error_message = "credit_specification is set only for t2, t3 and t3a."
  }
}

run "policy_change_leaves_out_unset_fields_and_the_size_limit" {
  command = plan

  variables {
    runner_policy = {
      allowedApps = [
        { exe = "Notepad.exe", path = "C:\\Windows\\System32\\Notepad.exe" },
        { exe = "Tool.exe", path = "D:\\Apps\\Tool.exe", sha256 = "ab${join("", [for i in range(31) : "cd"])}", allowUserWritable = true },
      ]
      maxFileBytes = 1048576
    }
  }

  assert {
    condition = local.policy_change_json == jsonencode({
      allowedApps = [
        { exe = "Notepad.exe", path = "C:\\Windows\\System32\\Notepad.exe" },
        { allowUserWritable = true, exe = "Tool.exe", path = "D:\\Apps\\Tool.exe", sha256 = "ab${join("", [for i in range(31) : "cd"])}" },
      ]
      gatedKeys     = []
      writeControls = []
    })
    error_message = "Unset optional fields and maxFileBytes are left out of the policy change (RpaPolicy.exe refuses null fields, unknown keys and maxFileBytes)."
  }
}

run "refuses_a_policy_change_of_more_than_40_entries" {
  command = plan
  variables {
    runner_policy = {
      allowedApps = [{ exe = "ErpDemo.exe", path = "C:\\Apps\\ErpDemo.exe", allowedArgs = [["--ui", "v1"]] }]
      gatedKeys   = [for i in range(39) : "Ctrl+F${i % 12 + 1}"]
    }
  }
  expect_failures = [var.runner_policy]
}

run "refuses_a_policy_value_over_260_characters" {
  command = plan
  variables {
    runner_policy = {
      allowedApps   = [{ exe = "ErpDemo.exe", path = "C:\\Apps\\ErpDemo.exe" }]
      writeControls = [{ exe = "ErpDemo.exe", automationId = join("", [for i in range(261) : "a"]) }]
    }
  }
  expect_failures = [var.runner_policy]
}

run "refuses_a_short_name_in_a_policy_path" {
  command = plan
  variables {
    runner_policy = { allowedApps = [{ exe = "ErpDemo.exe", path = "C:\\PROGRA~1\\ERP Demo\\ErpDemo.exe" }] }
  }
  expect_failures = [var.runner_policy]
}

run "refuses_a_policy_app_without_an_absolute_path" {
  command = plan
  variables {
    runner_policy = { allowedApps = [{ exe = "ErpDemo.exe", path = "ErpDemo.exe" }] }
  }
  expect_failures = [var.runner_policy]
}

run "refuses_a_policy_path_for_another_exe" {
  command = plan
  variables {
    runner_policy = { allowedApps = [{ exe = "ErpDemo.exe", path = "C:\\Windows\\System32\\cmd.exe" }] }
  }
  expect_failures = [var.runner_policy]
}

run "refuses_a_unc_policy_path" {
  command = plan
  variables {
    runner_policy = { allowedApps = [{ exe = "ErpDemo.exe", path = "\\\\server\\share\\ErpDemo.exe" }] }
  }
  expect_failures = [var.runner_policy]
}

run "refuses_the_whole_internet" {
  command = plan
  variables {
    allowed_cidrs = ["0.0.0.0/0"]
  }
  expect_failures = [var.allowed_cidrs]
}

run "refuses_ipv6_everywhere" {
  command = plan
  variables {
    allowed_cidrs = ["::/0"]
  }
  expect_failures = [var.allowed_cidrs]
}

run "refuses_half_the_internet" {
  command = plan
  variables {
    allowed_cidrs = ["203.0.113.7/32", "0.0.0.0/1"]
  }
  expect_failures = [var.allowed_cidrs]
}

run "refuses_a_slash_8" {
  command = plan
  variables {
    allowed_cidrs = ["3.0.0.0/8"]
  }
  expect_failures = [var.allowed_cidrs]
}

run "refuses_an_ipv6_slash_32" {
  command = plan
  variables {
    allowed_cidrs = ["2001:db8::/32"]
  }
  expect_failures = [var.allowed_cidrs]
}

run "accepts_a_slash_16_and_an_ipv6_slash_48" {
  command = plan
  variables {
    allowed_cidrs = ["10.20.0.0/16", "2001:db8:1::/48"]
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.allowed) == 6
    error_message = "/16 and /48 are the widest ranges allowed."
  }
}

run "refuses_no_cidr" {
  command = plan
  variables {
    allowed_cidrs = []
  }
  expect_failures = [var.allowed_cidrs]
}

run "refuses_host_bits_and_bare_addresses" {
  command = plan
  variables {
    allowed_cidrs = ["203.0.113.7/24"]
  }
  expect_failures = [var.allowed_cidrs]
}

run "refuses_a_bare_address" {
  command = plan
  variables {
    allowed_cidrs = ["203.0.113.7"]
  }
  expect_failures = [var.allowed_cidrs]
}

run "refuses_an_arm_instance_type" {
  command = plan
  variables {
    instance_type = "t4g.large"
  }
  expect_failures = [var.instance_type]
}

run "refuses_a_package_url_without_a_hash" {
  command = plan
  variables {
    package_url = "https://example.com/rpa-windows-x64.zip"
  }
  expect_failures = [var.package_url]
}

run "refuses_a_package_hash_without_a_url" {
  command = plan
  variables {
    package_sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
  expect_failures = [var.package_url]
}

run "refuses_a_plain_http_package_url" {
  command = plan
  variables {
    package_url    = "http://example.com/rpa-windows-x64.zip"
    package_sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
  expect_failures = [var.package_url]
}

run "refuses_a_quote_in_the_package_url" {
  command = plan
  variables {
    package_url    = "https://example.com/a'b.zip"
    package_sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
  expect_failures = [var.package_url]
}

run "refuses_a_typographic_quote_in_the_package_url" {
  command = plan
  variables {
    # U+2019: Windows PowerShell reads it as a single quote.
    package_url    = "https://example.com/a\u2019b.zip"
    package_sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
  expect_failures = [var.package_url]
}

run "refuses_a_short_sha256" {
  command = plan
  variables {
    package_url    = "https://example.com/rpa-windows-x64.zip"
    package_sha256 = "abc123"
  }
  expect_failures = [var.package_sha256]
}

run "refuses_rdp_as_runner_port" {
  command = plan
  variables {
    runner_port = 3389
  }
  expect_failures = [var.runner_port]
}

run "refuses_the_runner_port_as_browser_port" {
  command = plan
  variables {
    browser_port = 8765
  }
  expect_failures = [var.browser_port]
}

run "refuses_rdp_as_browser_port" {
  command = plan
  variables {
    browser_port = 3389
  }
  expect_failures = [var.browser_port]
}

run "refuses_a_public_ip_less_vm_in_its_own_vpc" {
  command = plan
  variables {
    associate_public_ip = false
  }
  expect_failures = [aws_instance.this]
}
