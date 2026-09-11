#!/usr/bin/env bun
/**
 * The issuer worker, served over plain HTTP for the local rig.
 *
 * Same handler, no second implementation: `worker/issuer.ts` is written
 * against the Request/Response interface, so Bun can serve it directly. It
 * runs inside the auth container's network namespace (compose.yml
 * `network_mode: service:auth`), which is what lets GoTrue address both the
 * issuer and the Before User Created hook as 127.0.0.1 - the hook config
 * validator only accepts `http` for localhost, 127.0.0.1, ::1 and
 * host.docker.internal (internal/conf/configuration.go
 * ValidateExtensibilityPoint).
 */
import worker from "../worker/issuer";

const port = Number(process.env.ISSUER_PORT ?? 8080);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch: (req) => worker.fetch(req, {}),
});

console.log(`issuer listening on :${port}`);
