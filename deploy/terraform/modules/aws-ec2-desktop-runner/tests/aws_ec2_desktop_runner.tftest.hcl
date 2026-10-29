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

run "runner_port_and_rdp_only_from_allowed_cidrs" {
  command = plan

  assert {
    condition = toset(keys(aws_vpc_security_group_ingress_rule.allowed)) == toset([
      "runner 203.0.113.7/32", "runner 198.51.100.0/24", "rdp 203.0.113.7/32", "rdp 198.51.100.0/24",
    ])
    error_message = "One ingress rule per port (runner, RDP) and allowed CIDR, nothing more."
  }
  assert {
    condition = alltrue([
      for k, r in aws_vpc_security_group_ingress_rule.allowed :
      r.security_group_id == "sg-0aaaaaaaaaaaaaaaa" && r.ip_protocol == "tcp" && r.from_port == r.to_port &&
      r.from_port == (startswith(k, "rdp ") ? 3389 : 8765) && r.cidr_ipv4 == split(" ", k)[1] && r.cidr_ipv6 == null
    ])
    error_message = "Ingress is TCP 8765 or 3389, a single port, from the rule's own CIDR."
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
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-user-password-GhIjKl",
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-admin-password-MnOpQr",
      ]
    }]
    error_message = "The inline policy allows exactly PutSecretValue on the three secrets: no read, no wildcard."
  }
  assert {
    condition     = jsondecode(aws_iam_role.this.assume_role_policy).Statement[0].Principal == { Service = "ec2.amazonaws.com" }
    error_message = "Only EC2 assumes the role."
  }
}

run "user_data_carries_settings_but_no_secret" {
  command = plan

  assert {
    # 16384 is EC2's limit; the default setup (about 8 KB) leaves room for a long policy and a pre-signed URL.
    condition     = local.user_data_size <= 10240 && startswith(local.user_data, "<powershell>") && endswith(trimspace(local.user_data), "</powershell>")
    error_message = "The user data is one PowerShell block of at most 10 KB by default."
  }
  assert {
    condition     = strcontains(local.user_data, "FromBase64String('${base64gzip(local.setup)}')") && !strcontains(local.setup, "\n#") && startswith(local.setup_full, "#")
    error_message = "The user data carries the setup script gzipped, without its comment lines."
  }
  assert {
    condition = alltrue([for v in [
      jsonencode({ allowedApps = [{ exe = "ErpDemo.exe" }], gatedKeys = ["Ctrl+S", "F11"], maxFileBytes = 20971520, writeControls = [{ automationId = "btnPost", exe = "ErpDemo.exe" }] }),
      jsonencode({ args = [], exe = "rpa-desktop-runner.exe", port = 8765 }),
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-token-AbCdEf",
      "us-west-2",
    ] : strcontains(local.setup, "'${base64encode(v)}'")])
    error_message = "The policy, the runner settings, the secret ARNs and the region reach the VM base64-encoded."
  }
  assert {
    condition     = strcontains(local.setup, "Dec ''") && strcontains(local.setup, "Register-ScheduledTask") && strcontains(local.setup, "LsaStorePrivateData")
    error_message = "No artifact URL by default; the scheduled task and the LSA auto-logon secret are set up."
  }
  assert {
    # Only Winlogon's LSA secret holds the auto-logon password; the plain-text registry value is removed, never set.
    condition     = !can(regex("Set-Reg[^\\n]*'DefaultPassword'", local.setup)) && strcontains(local.setup, "-Name 'DefaultPassword', 'AutoLogonCount'")
    error_message = "The user data never writes Winlogon's DefaultPassword registry value."
  }
  assert {
    condition     = strcontains(local.setup, "Start-Process @start") && strcontains(local.setup, "Expand-Archive")
    error_message = "start-runner.ps1 and install-runner.ps1 are embedded."
  }
  assert {
    condition     = strcontains(local.setup, "Set-NetFirewallProfile -All -Enabled True") && strcontains(local.setup, "-notmatch 'rpa|runner|admin'")
    error_message = "The firewall is on before the metadata block, and passwords avoid the account names."
  }
  assert {
    condition     = aws_instance.this.user_data_replace_on_change == true
    error_message = "A changed setup replaces the VM, since user data runs only on the first boot."
  }
}

run "outputs_give_url_arns_and_the_fingerprint_command" {
  command = plan

  assert {
    condition     = output.runner_url == "wss://203.0.113.50:8765/rpa/v1" && output.public_ip == "203.0.113.50" && output.instance_id == "i-0123456789abcdef0" && output.region == "us-west-2"
    error_message = "runner_url is wss://<public IP>:8765/rpa/v1."
  }
  assert {
    condition = (
      output.runner_token_secret_arn == "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-token-AbCdEf" &&
      output.runner_user_password_secret_arn == "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-runner-user-password-GhIjKl" &&
      output.admin_password_secret_arn == "arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-admin-password-MnOpQr"
    )
    error_message = "The secrets come out as ARNs."
  }
  assert {
    condition = (
      strcontains(output.fingerprint_command, "aws ssm send-command --region us-west-2 --instance-ids i-0123456789abcdef0 --document-name AWS-RunPowerShellScript") &&
      strcontains(output.fingerprint_command, "aws ssm get-command-invocation --region us-west-2 --instance-id i-0123456789abcdef0") &&
      strcontains(output.fingerprint_command, "'\\''([0-9A-F]{2}:){31}[0-9A-F]{2}'\\''") &&
      !strcontains(output.fingerprint_command, "-Recurse")
    )
    error_message = "fingerprint_command runs the log search through SSM, with the pattern's single quotes escaped for the shell."
  }
}

run "rdp_can_be_closed" {
  command = plan

  variables {
    enable_rdp = false
  }

  assert {
    condition     = toset(keys(aws_vpc_security_group_ingress_rule.allowed)) == toset(["runner 203.0.113.7/32", "runner 198.51.100.0/24"])
    error_message = "enable_rdp = false leaves only the runner port."
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

run "runner_artifact_reaches_the_vm" {
  command = plan

  variables {
    runner_artifact_url    = "https://github.com/example/releases/download/v1/rpa-desktop-runner-win-x64.zip"
    runner_artifact_sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    runner_arguments       = ["--log-level", "debug"]
  }

  assert {
    condition = (
      strcontains(local.setup, "'${base64encode("https://github.com/example/releases/download/v1/rpa-desktop-runner-win-x64.zip")}'") &&
      strcontains(local.setup, "'${base64encode(jsonencode({ args = ["--log-level", "debug"], exe = "rpa-desktop-runner.exe", port = 8765 }))}'")
    )
    error_message = "The artifact URL and the runner arguments reach the VM."
  }
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
    condition     = length(aws_vpc_security_group_ingress_rule.allowed) == 4
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

run "refuses_a_plain_http_artifact_url" {
  command = plan
  variables {
    runner_artifact_url = "http://example.com/rpa-desktop-runner.zip"
  }
  expect_failures = [var.runner_artifact_url]
}

run "refuses_a_quote_in_the_artifact_url" {
  command = plan
  variables {
    runner_artifact_url = "https://example.com/a'b.zip"
  }
  expect_failures = [var.runner_artifact_url]
}

run "refuses_a_short_sha256" {
  command = plan
  variables {
    runner_artifact_sha256 = "abc123"
  }
  expect_failures = [var.runner_artifact_sha256]
}

run "refuses_rdp_as_runner_port" {
  command = plan
  variables {
    runner_port = 3389
  }
  expect_failures = [var.runner_port]
}

run "refuses_a_public_ip_less_vm_in_its_own_vpc" {
  command = plan
  variables {
    associate_public_ip = false
  }
  expect_failures = [aws_instance.this]
}
