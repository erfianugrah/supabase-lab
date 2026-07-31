#!/bin/bash
# tls-tests.sh - TLS behaviour through the endpoint, runs ON the runner.
# The target design is verify-full via Route53 PHZ - this proves it, plus the
# fallbacks. Extracts the presented chain via openssl
# (lab TOFU; production guidance is the dashboard CA download).
#
# Env: DB_PASSWORD (required)
set -uo pipefail
. /etc/pvlab/env

CA=/etc/pvlab/ca.crt
export PGCONNECT_TIMEOUT=8 PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD required}"

t() { echo "$(date +%H:%M:%S) $1 $2 - $3"; }

echo "== extract presented chain from the endpoint (starttls postgres) =="
openssl s_client -starttls postgres -connect "$PHZ_HOST:5432" -showcerts </dev/null 2>/dev/null \
	| awk '/BEGIN CERT/,/END CERT/' > "$CA"
n=$(grep -c 'BEGIN CERTIFICATE' "$CA" || true)
echo "certs in chain: $n"
[ "$n" -ge 1 ] || { t FAIL TLS "no certs extracted - openssl starttls failed"; exit 1; }

echo "== T05 verify-full via PHZ name (the target design) =="
if psql "host=$PHZ_HOST port=5432 user=postgres dbname=postgres sslmode=verify-full sslrootcert=$CA" -c 'select 1;' >/dev/null 2>&1; then
	t PASS T05 "verify-full via Route53 PHZ name"
else
	t FAIL T05 "verify-full via Route53 PHZ name"
fi

echo "== T06 verify-ca via PHZ name =="
if psql "host=$PHZ_HOST port=5432 user=postgres dbname=postgres sslmode=verify-ca sslrootcert=$CA" -c 'select 1;' >/dev/null 2>&1; then
	t PASS T06 "verify-ca with extracted chain"
else
	t FAIL T06 "verify-ca with extracted chain"
fi

ip=$(echo $ENDPOINT_IPS | awk '{print $1}')
echo "== T04b verify-full with host/hostaddr split (no DNS dependency) =="
if psql "host=$PHZ_HOST hostaddr=$ip port=5432 user=postgres dbname=postgres sslmode=verify-full sslrootcert=$CA" -c 'select 1;' >/dev/null 2>&1; then
	t PASS T04b "verify-full host=PHZ-name hostaddr=$ip"
else
	t FAIL T04b "verify-full host=PHZ-name hostaddr=$ip"
fi

echo "== T04c verify-full against raw endpoint IP - expect FAIL by design =="
if psql "host=$ip port=5432 user=postgres dbname=postgres sslmode=verify-full sslrootcert=$CA" -c 'select 1;' >/dev/null 2>&1; then
	t FAIL T04c "verify-full against raw IP SUCCEEDED - unexpected (IP in cert?)"
else
	t PASS T04c "verify-full against raw IP fails by design (hostname mismatch)"
fi

echo "== T04d cert SANs presented on the endpoint (evidence for the cert claim) =="
openssl s_client -starttls postgres -connect "$PHZ_HOST:5432" </dev/null 2>/dev/null \
	| openssl x509 -noout -subject -ext subjectAltName 2>/dev/null | head -6

echo "== tls-tests done =="
