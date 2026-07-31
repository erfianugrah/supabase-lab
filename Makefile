SOPS := sops --input-type binary --output-type binary

.PHONY: secrets-decrypt secrets-encrypt experiments

experiments:
	@ls experiments/

# Decrypt the committed secrets.enc.tfvars to secrets.tfvars (gitignored).
secrets-decrypt:
	$(SOPS) -d secrets.enc.tfvars > secrets.tfvars
	@echo "secrets.tfvars written (gitignored)"

# Re-encrypt after editing secrets.tfvars. The plaintext stays local.
secrets-encrypt:
	$(SOPS) -e secrets.tfvars > secrets.enc.tfvars
	@echo "secrets.enc.tfvars updated (commit this)"
