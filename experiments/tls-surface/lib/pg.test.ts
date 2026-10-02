import { describe, expect, test } from "bun:test";
import { isEnforcementRefusal, parseConninfo } from "./pg";

// psql 18.6 `\conninfo` in -A -t mode, captured against a local cluster
// with ssl=on on 2026-10-02, followed by the query's own output row.
const TLS = `Database|postgres
Client User|postgres
Host|127.0.0.1
Server Port|55432
Protocol Version|3.0
Backend PID|258796
SSL Connection|true
SSL Library|OpenSSL
SSL Protocol|TLSv1.3
SSL Key Bits|256
SSL Cipher|TLS_AES_256_GCM_SHA384
SSL Compression|false
ALPN|postgresql
Superuser|on
Hot Standby|off
true|TLSv1.3|TLS_AES_256_GCM_SHA384`;

const PLAIN = `Database|postgres
Client User|postgres
Backend PID|258798
SSL Connection|false
Superuser|on
Hot Standby|off
false|-|-`;

describe("parseConninfo", () => {
  test("TLS client leg, with the query row kept separate", () => {
    expect(parseConninfo(TLS)).toEqual({ client: "TLSv1.3 TLS_AES_256_GCM_SHA384", rest: "true|TLSv1.3|TLS_AES_256_GCM_SHA384" });
  });
  test("plaintext client leg", () => {
    expect(parseConninfo(PLAIN)).toEqual({ client: "plaintext", rest: "false|-|-" });
  });
  test("no conninfo block at all", () => {
    expect(parseConninfo("42")).toEqual({ client: "?", rest: "42" });
  });
});

describe("isEnforcementRefusal", () => {
  // The three refusal texts seen per path on 2026-10-02 (TL16).
  test.each([
    'connection to server at "h" (a), port 5432 failed: FATAL: (ESSLREQUIRED) SSL connection is required for user: postgres',
    'connection to server at "h" (a), port 5432 failed: FATAL: no pg_hba.conf entry for host "x", user "postgres", database "postgres", no encryption',
    'connection to server at "h" (a), port 6543 failed: FATAL: SSL required',
  ])("refusal: %s", (err) => expect(isEnforcementRefusal(err)).toBe(true));

  // What a restart looks like - must NOT count as the enforcement refusal.
  test.each([
    'connection to server at "h" (a), port 5432 failed: Connection refused Is the server running on that host and accepting TCP/IP connections?',
    "SSL SYSCALL error: EOF detected",
    "FATAL: the database system is shutting down",
    "server closed the connection unexpectedly",
    "timeout expired",
  ])("not a refusal: %s", (err) => expect(isEnforcementRefusal(err)).toBe(false));
});
