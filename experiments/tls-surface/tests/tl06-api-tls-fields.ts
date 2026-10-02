/**
 * TL06 - what the public Management API spec exposes about TLS: the SSL
 * enforcement endpoint, the custom-hostname schema, and any field whose name
 * mentions a cipher or TLS version.
 *
 * Field names are matched by pattern rather than by a known schema, so a
 * field added later shows up in `cipher_fields` without a code change, and
 * `pvlab --diff` between two runs shows it.
 * Read-only, unauthenticated.
 */
import type { TestModule } from "../../../harness/src/types";

const SPEC = "https://api.supabase.com/api/v1-json";

/** Pure: every schema property path whose name matches, e.g. `CustomHostnameResponse.min_tls_version`. */
export function tlsFields(spec: { components?: { schemas?: Record<string, unknown> } }): string[] {
  const hits = new Set<string>();
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const props = (node as { properties?: Record<string, unknown> }).properties;
    if (props)
      for (const [k, v] of Object.entries(props)) {
        if (/cipher|tls|ssl/i.test(k)) hits.add(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    for (const key of ["items", "allOf", "anyOf", "oneOf"]) {
      const child = (node as Record<string, unknown>)[key];
      if (Array.isArray(child)) child.forEach((c) => walk(c, path));
      else if (child) walk(child, path);
    }
  };
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) walk(schema, name);
  return [...hits].sort();
}

const mod: TestModule = {
  id: "TL06",
  title: "Management API spec: TLS-related endpoints and schema fields",
  where: "local",
  async run() {
    const res = await fetch(SPEC, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res?.ok) return [{ id: "TL06", title: mod.title, status: "info", detail: `spec fetch failed (${res?.status ?? "network"})` }];
    const spec = (await res.json()) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    const paths = Object.keys(spec.paths ?? {}).filter((p) => /ssl|tls|cipher|custom-hostname|vanity/i.test(p));
    const fields = tlsFields(spec);
    const cipher = fields.filter((f) => /cipher|tls/i.test(f.split(".").pop() ?? ""));
    return [
      {
        id: "TL06",
        title: mod.title,
        status: "info",
        detail: `${paths.length} TLS-adjacent paths [${paths.join(", ")}]; schema fields naming ssl/tls/cipher: ${fields.join(", ") || "none"}; cipher/TLS-version controls: ${cipher.join(", ") || "none in the public spec"}`,
        measurements: { tls_paths: paths.join(" "), ssl_fields: fields.join(" ") || "none", cipher_fields: cipher.join(" ") || "none" },
      },
    ];
  },
};
export default mod;
