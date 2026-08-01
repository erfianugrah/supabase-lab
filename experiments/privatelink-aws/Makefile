ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
ARNVARS := $(if $(wildcard arns.tfvars),-var-file=arns.tfvars,)
REF := $(shell tofu output -raw project_ref 2>/dev/null)

# tofu reads AWS creds from secrets.tfvars via the provider block, but the aws
# CLI calls below cannot read tfvars - export the same values so both agree on
# one source of truth. Empty (keys absent from secrets.tfvars, or file not yet
# decrypted) exports empty, which the CLI ignores and falls back to the profile
# chain - and which also neutralises a stale key pair inherited from the shell.
export AWS_ACCESS_KEY_ID := $(shell grep -E '^aws_access_key_id' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
export AWS_SECRET_ACCESS_KEY := $(shell grep -E '^aws_secret_access_key' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)

.PHONY: init fmt validate phase1 wait-ready arns phase2 plan apply destroy suite suite-clean ssm restrict unrestrict lambda-zip lambda-secret

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

# Phase 1: project + PrivateLink association only. The RAM share does not
# exist until the association reaches READY, so phase 2 resources are gated
# on arns.tfvars.
phase1:
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan

# Watch the association status. CREATION_FAILED is the state a
# new-VPC-generation block would surface as - that is a finding, not a bug
# in this lab; capture it.
wait-ready:
	@test -n "$(REF)" || (echo "no project_ref output - run phase1 first"; exit 1)
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN first"; exit 1)
	@while true; do \
		st=$$(curl -s "https://api.supabase.com/platform/projects/$(REF)/privatelink/associations" \
			-H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" \
			| jq -r '.private_link_associations[0].status // "UNKNOWN"'); \
		echo "$$(date +%H:%M:%S) $$st"; \
		case "$$st" in \
			READY|ASSOCIATION_ACCEPTED) exit 0 ;; \
			CREATION_FAILED) echo "CREATION_FAILED - possible new-VPC-generation block, investigate"; exit 1 ;; \
			UNKNOWN) echo "unexpected response shape - endpoint may have moved; check dashboard"; exit 2 ;; \
		esac; \
		sleep 15; \
	done

# Pull the RAM share ARN + Lattice resource configuration ARN into arns.tfvars.
# Accepts the invitation first if PENDING (idempotent) - the resource
# configuration is invisible to list-resources until accepted.
arns:
	@test -n "$(REF)" || (echo "no project_ref output - run phase1 first"; exit 1)
	region=$$(grep aws_region experiment.tfvars | cut -d'"' -f2); \
	inv=$$(aws ram get-resource-share-invitations --region $$region --no-paginate \
		--query "resourceShareInvitations[?resourceShareName && contains(resourceShareName, '$(REF)')].resourceShareInvitationArn | [0]" --output text); \
	test "$$inv" != "None" -a -n "$$inv" || (echo "no RAM invitation for $(REF) yet - add the AWS account in the dashboard first"; exit 1); \
	st=$$(aws ram get-resource-share-invitations --region $$region --no-paginate \
		--query "resourceShareInvitations[?resourceShareInvitationArn=='$$inv'].status | [0]" --output text); \
	if [ "$$st" = "PENDING" ]; then \
		aws ram accept-resource-share-invitation --region $$region --resource-share-invitation-arn "$$inv" --query 'resourceShareInvitation.status' --output text; \
	fi; \
	share=$$(aws ram get-resource-share-invitations --region $$region --no-paginate \
		--query "resourceShareInvitations[?resourceShareName && contains(resourceShareName, '$(REF)')].resourceShareArn | [0]" --output text); \
	rc=$$(aws ram list-resources --resource-owner OTHER-ACCOUNTS --resource-share-arn "$$share" \
		--region $$region --no-paginate \
		--query 'resources[0].arn' --output text | head -1); \
	printf 'resource_share_arn = "%s"\nresource_configuration_arn = "%s"\n' "$$share" "$$rc" > arns.tfvars; \
	cat arns.tfvars

# Two-pass: the ENI data source keys off the endpoint's network_interface_ids,
# which are unknown until the endpoint exists (for_each over unknown = plan
# error), and a Resource endpoint's ENI type/description is not documented -
# so the endpoint goes in first, then the rest resolves against real IDs.
phase2:
	@test -f arns.tfvars || (echo "arns.tfvars missing - run make arns first"; exit 1)
	tofu plan $(VARS) $(ARNVARS) -target='aws_vpc_endpoint.supabase[0]' -out=tfplan-endpoint
	tofu apply tfplan-endpoint
	tofu plan $(VARS) $(ARNVARS) -out=tfplan
	tofu apply tfplan

plan:
	tofu plan $(VARS) $(ARNVARS)

apply:
	tofu plan $(VARS) $(ARNVARS) -out=tfplan
	tofu apply tfplan

destroy:
	tofu plan $(VARS) $(ARNVARS) -destroy -out=destroy.tfplan
	tofu apply destroy.tfplan
	@rm -f arns.tfvars destroy.tfplan tfplan tfplan-*
	@echo "arns.tfvars removed - it gates phase 2, and a stale copy against empty"
	@echo "state makes the next plan fail on the ENI for_each (unknown keys)."

# Full automated suite: deploy scripts + gocurl to the runner, run TLS /
# latency / ceiling / restart phases, pull artifacts, render evidence/<ts>/REPORT.md
suite:
	@chmod +x suite.sh render-report.sh
	./suite.sh

# The suite artifact bucket is created by suite.sh (orchestration), not by
# tofu, so `make destroy` does not cover it.
suite-clean:
	@ACCOUNT=$$(grep -E '^aws_account_id' $(ROOT)/secrets.tfvars | cut -d'"' -f2); \
	aws s3 rb "s3://supabase-lab-suite-$$ACCOUNT" --force && echo "suite bucket removed"

ssm:
	aws ssm start-session --target $$(tofu output -raw runner_id) \
		--region $(shell grep aws_region experiment.tfvars | cut -d'"' -f2)

# T12: close public DB access to break-glass only (requires IP=x.x.x.x).
restrict:
	@test -n "$(IP)" || (echo "usage: make restrict IP=x.x.x.x"; exit 1)
	tofu apply $(VARS) $(ARNVARS) -var 'public_access_cidrs=["$(IP)/32"]' -auto-approve

unrestrict:
	tofu apply $(VARS) $(ARNVARS) -auto-approve

lambda-zip:
	cd lambda && bun install --production && mkdir -p dist && cp index.mjs dist/ && cp -r node_modules dist/ \
		&& echo "dist ready - set enable_lambda=true and apply"

lambda-secret:
	@aws lambda update-function-configuration --function-name supabase-lab-probe \
		--region $(shell grep aws_region experiment.tfvars | cut -d'"' -f2) \
		--environment "Variables={PGHOST=$(shell tofu output -raw phz_host),PGUSER=postgres,PGDATABASE=postgres,PGSSLMODE=require,PGPASSWORD=$(DBPW)}" \
		--query 'FunctionName' --output text && echo "PGPASSWORD set"
