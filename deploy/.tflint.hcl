# tflint for deploy/terraform (make -C deploy check runs tflint --recursive with this file). Only the bundled terraform
# ruleset is used, so tflint needs no plugin download (no tflint --init, no GitHub token).
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "all"
}
