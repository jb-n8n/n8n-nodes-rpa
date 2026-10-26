# Checks for deploy/ without a cluster or cloud account. Run from the repository root: make -C deploy check
#   fmt        terraform fmt -check over every module and example
#   terraform  for each module and example: terraform init -backend=false, validate, test (mock providers, plan only),
#              then tests/chart.sh where there is one (the module's values rendered through the real chart).
#              make -C deploy check TF_ROOTS="terraform/modules/k8s-browser ..." limits it to those roots (CI's
#              Terraform 1.11 job does). The managed example fetches n8n's module from the registry.
#   tflint     tflint --recursive with .tflint.hcl; skipped with a notice when tflint is not installed, unless
#              REQUIRE_TFLINT=1 (CI sets it, so a missing tflint fails there)
#   helm       the chart's render checks (helm lint, helm template | kubeconform, the policy asserts)
# Needs terraform >= 1.11, helm, kubeconform and node; tflint optional locally. terraform init and kubeconform download
# providers and schemas, so the first run needs the network.
#
# Terraform's working data (.terraform) goes to a cache outside the tree, one directory per module or example, so the
# checks leave nothing to commit except the dependency lock files.

SHELL := /bin/bash
# .SHELLFLAGS needs GNU make 3.82+; macOS ships 3.81, so the multi-command recipes also start with `set -euo pipefail`.
.SHELLFLAGS := -euo pipefail -c

TF_ROOTS := $(sort $(patsubst %/,%,$(wildcard terraform/modules/*/ terraform/examples/*/)))
TF_DATA_ROOT ?= $(or $(XDG_CACHE_HOME),$(HOME)/.cache)/rpa-deploy-check$(CURDIR)

.PHONY: check fmt terraform tflint helm

check: fmt terraform tflint helm
	@echo "deploy check: all passed"

fmt:
	@echo "== terraform fmt"
	terraform fmt -check -recursive -diff terraform

terraform:
	@set -euo pipefail; \
	for root in $(TF_ROOTS); do \
	  echo "== terraform $$root"; \
	  export TF_DATA_DIR="$(TF_DATA_ROOT)/$$root"; \
	  mkdir -p "$$TF_DATA_DIR"; \
	  terraform -chdir="$$root" init -backend=false -input=false -no-color >"$$TF_DATA_DIR/init.log" 2>&1 \
	    || { cat "$$TF_DATA_DIR/init.log" >&2; echo "terraform init failed in $$root" >&2; exit 1; }; \
	  terraform -chdir="$$root" validate -no-color; \
	  terraform -chdir="$$root" test -no-color; \
	  if [ -x "$$root/tests/chart.sh" ]; then "$$root/tests/chart.sh"; fi; \
	done

tflint:
	@echo "== tflint"
	@set -euo pipefail; \
	if command -v tflint >/dev/null 2>&1; then \
	  cd terraform && tflint --recursive --config "$(CURDIR)/.tflint.hcl" --format compact && echo "tflint: no issues"; \
	elif [ "$${REQUIRE_TFLINT:-}" = 1 ]; then \
	  echo "tflint not found and REQUIRE_TFLINT=1" >&2; exit 1; \
	else \
	  echo "NOTICE: tflint not found, skipped (CI runs it; https://github.com/terraform-linters/tflint)"; \
	fi

helm:
	@echo "== helm chart"
	helm/rpa-browser/tests/render.sh
