import { describe, expect, test } from "bun:test";
import { ECDHE_CBC_SHA2, isCbc, parseCertText, parseHandshake, pool } from "./tls";

// Excerpts of real `openssl s_client` 3.6 output captured against
// api.supabase.com and the shared pooler on 2026-10-02, trimmed to the lines
// the parser reads (base64 bodies removed).
const OK13_OUT = `CONNECTED(00000003)
OCSP responses: no responses sent
---
Certificate chain
 0 s:CN=supabase.com
   i:C=US, O=Google Trust Services, CN=WE1
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA256
   v:NotBefore: Aug 25 10:52:10 2026 GMT; NotAfter: Nov 23 11:52:06 2026 GMT
 1 s:C=US, O=Google Trust Services, CN=WE1
   i:C=US, O=Google Trust Services LLC, CN=GTS Root R4
---
Server certificate
-----BEGIN CERTIFICATE-----
AAAA
-----END CERTIFICATE-----
subject=CN=supabase.com
issuer=C=US, O=Google Trust Services, CN=WE1
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: ecdsa_secp256r1_sha256
Negotiated TLS1.3 group: X25519MLKEM768
---
SSL handshake has read 3206 bytes and written 1592 bytes
Verification: OK
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 256 bit
ALPN protocol: h2
Early data was not sent
Verify return code: 0 (ok)
---
`;

const OK12_OUT = `CONNECTED(00000003)
---
Server certificate
subject=CN=supabase.com
issuer=C=US, O=Google Trust Services, CN=WR1
---
Peer signature type: rsa_pss_rsae_sha256
Peer Temp Key: X25519, 253 bits
---
New, TLSv1.2, Cipher is ECDHE-RSA-AES128-SHA256
Protocol: TLSv1.2
Server public key is 2048 bit
Secure Renegotiation IS supported
No ALPN negotiated
SSL-Session:
    Protocol  : TLSv1.2
    Cipher    : ECDHE-RSA-AES128-SHA256
    Verify return code: 0 (ok)
---
`;

const PROTO_REFUSED_OUT = `CONNECTED(00000003)
---
no peer certificate available
---
New, (NONE), Cipher is (NONE)
Protocol: TLSv1
No ALPN negotiated
SSL-Session:
    Protocol  : TLSv1
    Cipher    : 0000
    Verify return code: 0 (ok)
---
`;
const PROTO_REFUSED_ERR = `40375B9A467E0000:error:0A00042E:SSL routines:ssl3_read_bytes:tlsv1 alert protocol version:ssl/record/rec_layer_s3.c:918:SSL alert number 70
40375B9A467E0000:error:0A000197:SSL routines:SSL_shutdown:shutdown while in init:ssl/ssl_lib.c:2804:
`;
const CIPHER_REFUSED_ERR = `40C7C315E1750000:error:0A000410:SSL routines:ssl3_read_bytes:ssl/tls alert handshake failure:ssl/record/rec_layer_s3.c:918:SSL alert number 40
`;
const CLIENT_UNABLE_ERR = `40579C21D2700000:error:0A0000BF:SSL routines:tls_setup_handshake:no protocols available:ssl/statem/statem_lib.c:155:
`;

const PG_OUT = `CONNECTED(00000003)
---
Certificate chain
 0 s:C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=*.pooler.supabase.com
-----BEGIN CERTIFICATE-----
LEAF
-----END CERTIFICATE-----
 1 s:C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Intermediate 2021 CA
-----BEGIN CERTIFICATE-----
INTER
-----END CERTIFICATE-----
 2 s:C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA
-----BEGIN CERTIFICATE-----
ROOT
-----END CERTIFICATE-----
---
Server certificate
subject=C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=*.pooler.supabase.com
issuer=C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Intermediate 2021 CA
---
Peer Temp Key: X25519, 253 bits
---
Verification error: self-signed certificate in certificate chain
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
No ALPN negotiated
Verify return code: 19 (self-signed certificate in certificate chain)
---
`;

describe("parseHandshake", () => {
  test("TLS 1.3 success with ALPN, group and verification", () => {
    const h = parseHandshake(OK13_OUT, "", 0);
    expect(h.ok).toBe(true);
    expect(h.protocol).toBe("TLSv1.3");
    expect(h.cipher).toBe("TLS_AES_256_GCM_SHA384");
    expect(h.alpn).toBe("h2");
    expect(h.group).toBe("X25519MLKEM768");
    expect(h.verifyCode).toBe(0);
    expect(h.subject).toBe("CN=supabase.com");
    expect(h.issuer).toBe("C=US, O=Google Trust Services, CN=WE1");
    expect(h.ocsp).toBe("none");
    expect(h.pems.length).toBe(1);
  });

  test("TLS 1.2's OCSP wording is read as no staple", () => {
    const h = parseHandshake(`${OK12_OUT}OCSP response: no OCSP response received\n`, "", 0);
    expect(h.ocsp).toBe("none");
  });

  test("TLS 1.2 success reads the temp key as the group", () => {
    const h = parseHandshake(OK12_OUT, "", 0);
    expect(h.ok).toBe(true);
    expect(h.protocol).toBe("TLSv1.2");
    expect(h.cipher).toBe("ECDHE-RSA-AES128-SHA256");
    expect(h.alpn).toBe("");
    expect(h.group).toBe("X25519, 253 bits");
  });

  test("a legacy suite on TLS 1.2 reports TLSv1.2, not the suite's SSLv3 label", () => {
    const out = "CONNECTED(00000003)\nNew, SSLv3, Cipher is AES128-SHA\nProtocol: TLSv1.2\nVerify return code: 0 (ok)\n";
    const h = parseHandshake(out, "", 0);
    expect(h.protocol).toBe("TLSv1.2");
    expect(h.cipher).toBe("AES128-SHA");
  });

  test("server protocol refusal is a server-side alert 70", () => {
    const h = parseHandshake(PROTO_REFUSED_OUT, PROTO_REFUSED_ERR, 1);
    expect(h.ok).toBe(false);
    expect(h.clientSide).toBe(false);
    expect(h.alertNum).toBe(70);
    expect(h.alert).toBe("protocol version");
    expect(h.outcome).toBe("refused:alert70");
  });

  test("cipher refusal is alert 40 handshake failure", () => {
    const h = parseHandshake(PROTO_REFUSED_OUT, CIPHER_REFUSED_ERR, 1);
    expect(h.alertNum).toBe(40);
    expect(h.alert).toBe("handshake failure");
    expect(h.outcome).toBe("refused:alert40");
  });

  test("a client that cannot even offer the protocol is not a server result", () => {
    const h = parseHandshake("New, (NONE), Cipher is (NONE)\n", CLIENT_UNABLE_ERR, 1);
    expect(h.ok).toBe(false);
    expect(h.clientSide).toBe(true);
    expect(h.outcome).toBe("client-unable");
  });

  test("a plaintext reply to a ClientHello is not-tls", () => {
    const err = "40373CC7DC7D0000:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number:ssl/record/methods/tlsany_meth.c:77:\n";
    expect(parseHandshake("CONNECTED(00000003)\nNew, (NONE), Cipher is (NONE)\n", err, 1).outcome).toBe("not-tls");
  });

  test("timeout and connect errors are distinguished", () => {
    expect(parseHandshake("", "", 124).outcome).toBe("timeout");
    expect(parseHandshake("", "connect:errno=111\n", 1).outcome).toBe("no-connect");
  });

  test("postgres STARTTLS: full chain, root last, self-signed root verify code", () => {
    const h = parseHandshake(PG_OUT, "", 0);
    expect(h.ok).toBe(true);
    expect(h.pems.length).toBe(3);
    expect(h.pems[2]).toContain("ROOT");
    expect(h.verifyCode).toBe(19);
    expect(h.verify).toBe("self-signed certificate in certificate chain");
    expect(h.chainSubjects[2]).toContain("Supabase Root 2021 CA");
  });
});

describe("parseCertText", () => {
  test("reads key type, size, sans, dates", () => {
    const text = `Certificate:
    Data:
        Signature Algorithm: ecdsa-with-SHA256
        Validity
            Not Before: Aug 25 10:52:10 2026 GMT
            Not After : Nov 23 11:52:06 2026 GMT
        Subject Public Key Info:
            Public Key Algorithm: id-ecPublicKey
                Public-Key: (256 bit)
        X509v3 extensions:
            X509v3 Subject Alternative Name:
                DNS:supabase.com, DNS:*.supabase.com
`;
    const c = parseCertText(text, new Date("2026-10-02T00:00:00Z"));
    expect(c.keyType).toBe("EC");
    expect(c.keyBits).toBe(256);
    expect(c.sigAlg).toBe("ecdsa-with-SHA256");
    expect(c.sans).toEqual(["supabase.com", "*.supabase.com"]);
    expect(c.notAfter).toBe("2026-11-23");
    expect(c.daysLeft).toBe(52);
    expect(c.lifetimeDays).toBe(90);
  });
});

describe("cipher helpers", () => {
  test("the four ECDHE SHA-2 suites tracked per column are all CBC", () => {
    expect(ECDHE_CBC_SHA2.length).toBe(4);
    for (const c of ECDHE_CBC_SHA2) expect(isCbc(c)).toBe(true);
  });
  test("GCM, ChaCha and TLS 1.3 names are not CBC", () => {
    for (const c of ["ECDHE-RSA-AES128-GCM-SHA256", "ECDHE-ECDSA-CHACHA20-POLY1305", "TLS_AES_128_GCM_SHA256"]) expect(isCbc(c)).toBe(false);
  });
  test("legacy SHA1 CBC names count as CBC", () => {
    expect(isCbc("ECDHE-RSA-AES128-SHA")).toBe(true);
    expect(isCbc("AES256-SHA")).toBe(true);
    expect(isCbc("DES-CBC3-SHA")).toBe(true);
  });
});

describe("pool", () => {
  test("keeps order and bounds concurrency", async () => {
    let live = 0;
    let peak = 0;
    const out = await pool([5, 1, 3, 2, 4], 2, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await Bun.sleep(n);
      live--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

import { summariseHowsMySsl } from "./outbound";
import { tlsFields } from "../tests/tl06-api-tls-fields";

describe("tlsFields", () => {
  test("finds nested ssl/tls/cipher properties and nothing else", () => {
    const spec = {
      components: {
        schemas: {
          SslEnforcementRequest: { properties: { requestedConfig: { properties: { database: {} } } } },
          CustomHostname: { properties: { min_tls_version: {}, custom_hostname: {}, settings: { allOf: [{ properties: { ciphers: { items: {} } } }] } } },
          Other: { properties: { name: {} } },
        },
      },
    };
    expect(tlsFields(spec)).toEqual(["CustomHostname.min_tls_version", "CustomHostname.settings.ciphers"]);
  });
});

describe("summariseHowsMySsl", () => {
  test("counts offered and CBC suites", () => {
    const body = JSON.stringify({ tls_version: "TLS 1.3", rating: "Probably Okay", given_cipher_suites: ["TLS_AES_128_GCM_SHA256", "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA", "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA"], insecure_cipher_suites: {} });
    expect(summariseHowsMySsl(body)).toEqual({ client_tls: "TLS 1.3", client_rating: "Probably Okay", client_suites_offered: 3, client_cbc_offered: 2, client_insecure: 0 });
  });
  test("unparseable body is flagged, not thrown", () => {
    expect(summariseHowsMySsl("<html>")).toEqual({ client_tls: "unparsed" });
  });
});
