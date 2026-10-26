# Two roles, both with inline policies only.
# - Execution role (used by ECS to start the task): read the token secret, write the log stream, and pull from ECR only
#   when the image is in ECR.
# - Task role (the gate's own credentials): only ecs:UpdateTaskProtection, which the ECS agent calls for the gate's
#   PUT ${ECS_AGENT_URI}/task-protection/v1/state. The action's resource is a task
#   (arn:<partition>:ecs:<region>:<account>:task/<cluster>/<id>) and it supports the ecs:cluster condition key
#   (Service Authorization Reference, Amazon ECS). IAM can't name "this task", so the grant is the tasks of this cluster.
#   The gate never reads protection back, so ecs:GetTaskProtection is not granted.

locals {
  arn_parts    = split(":", var.cluster_arn)
  partition    = local.arn_parts[1]
  region       = local.arn_parts[3]
  account_id   = local.arn_parts[4]
  cluster_name = trimprefix(local.arn_parts[5], "cluster/")

  # <account>.dkr.ecr.<region>.amazonaws.com[.cn]/<repository>[:tag][@digest]
  ecr_match = try(regex("^([0-9]{12})\\.dkr\\.ecr(?:-fips)?\\.([a-z0-9-]+)\\.amazonaws\\.com(?:\\.cn)?/([^:@]+)", var.image), null)
  ecr_repository_arn = (
    local.ecr_match == null ? null :
    "arn:${local.partition}:ecr:${local.ecr_match[1]}:${local.ecr_match[0]}:repository/${local.ecr_match[2]}"
  )

  # The execution role's trust is the one the ECS docs give for it. The task role's adds the confused-deputy conditions
  # the ECS docs recommend for task roles (aws:SourceArn can't name one cluster, so it is every cluster of the account).
  execution_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  task_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:${local.partition}:ecs:${local.region}:${local.account_id}:*" }
      }
    }]
  })

  execution_statements = concat(
    [
      {
        Sid      = "ReadGateToken"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = local.token_secret_arn
      },
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${aws_cloudwatch_log_group.this.name}:*"
      },
    ],
    [for s in [{
      Sid      = "DecryptGateToken"
      Effect   = "Allow"
      Action   = "kms:Decrypt"
      Resource = var.token_kms_key_arn
    }] : s if var.token_kms_key_arn != null],
    [for s in [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid      = "EcrPull"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = local.ecr_repository_arn
      },
    ] : s if local.ecr_repository_arn != null],
  )
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  description        = "ECS starts the RPA browser tasks with this role: token secret, logs, image pull."
  assume_role_policy = local.execution_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy" "execution" {
  name = "${var.name}-execution"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.execution_statements
  })
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  description        = "The RPA browser gate's role: only its scale-in protection."
  assume_role_policy = local.task_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy" "task" {
  name = "${var.name}-task-protection"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TaskScaleInProtection"
      Effect    = "Allow"
      Action    = "ecs:UpdateTaskProtection"
      Resource  = "arn:${local.partition}:ecs:${local.region}:${local.account_id}:task/${local.cluster_name}/*"
      Condition = { ArnEquals = { "ecs:cluster" = var.cluster_arn } }
    }]
  })
}
