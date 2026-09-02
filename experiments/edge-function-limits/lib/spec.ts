/**
 * Pure readers over the published Management API OpenAPI document.
 *
 * The secrets limits are declared in the request schema itself (maxItems,
 * maxLength, a name pattern), so the CONTRACT can be compared to the docs
 * without a project. Kept free of I/O so it is unit-testable on a fixture;
 * EF01 does the fetch.
 */

export interface SecretsContract {
  /** Body is an array of secrets; this is its declared maxItems. */
  maxItems?: number;
  nameMaxLength?: number;
  /** Declared regex on the name, verbatim. */
  namePattern?: string;
  valueMaxLength?: number;
}

export interface DeployContract {
  /** The (deprecated) JSON/eszip create endpoint is still published. */
  legacyCreatePublished: boolean;
  legacyCreateDeprecated: boolean;
  /** Response codes the multipart deploy endpoint declares. */
  deployDeclaredResponses: string[];
  /** Metadata fields the multipart deploy accepts. */
  deployMetadataFields: string[];
  /** Whether static file patterns are part of the API deploy contract. */
  staticPatternsDeclared: boolean;
  /** Any string in the functions/secrets part of the document mentioning a size limit. */
  sizeLimitMentioned: boolean;
}

type J = Record<string, unknown>;

function deref(spec: J, node: unknown): J | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as J;
  const ref = n.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let cur: unknown = spec;
    for (const k of ref.slice(2).split("/")) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = (cur as J)[k];
    }
    return cur as J | undefined;
  }
  return n;
}

export function secretsContract(spec: J): SecretsContract {
  const paths = (spec.paths ?? {}) as J;
  const post = ((paths["/v1/projects/{ref}/secrets"] as J | undefined)?.post ?? {}) as J;
  const content = ((post.requestBody as J | undefined)?.content ?? {}) as J;
  const schema = deref(spec, (content["application/json"] as J | undefined)?.schema);
  if (!schema) return {};
  const items = deref(spec, schema.items) ?? {};
  const props = (items.properties ?? {}) as J;
  const name = (props.name ?? {}) as J;
  const value = (props.value ?? {}) as J;
  return {
    maxItems: typeof schema.maxItems === "number" ? schema.maxItems : undefined,
    nameMaxLength: typeof name.maxLength === "number" ? name.maxLength : undefined,
    namePattern: typeof name.pattern === "string" ? name.pattern : undefined,
    valueMaxLength: typeof value.maxLength === "number" ? value.maxLength : undefined,
  };
}

/** Does the declared name pattern reject the reserved prefix? */
export function patternRejectsPrefix(pattern: string | undefined, prefix: string): boolean {
  if (!pattern) return false;
  try {
    const re = new RegExp(pattern);
    return !re.test(`${prefix}X`) && re.test("PVLAB_X");
  } catch {
    return false;
  }
}

export function deployContract(spec: J): DeployContract {
  const paths = (spec.paths ?? {}) as J;
  const legacy = (paths["/v1/projects/{ref}/functions"] as J | undefined)?.post as J | undefined;
  const deploy = (paths["/v1/projects/{ref}/functions/deploy"] as J | undefined)?.post as J | undefined;
  const content = ((deploy?.requestBody as J | undefined)?.content ?? {}) as J;
  const body = deref(spec, (content["multipart/form-data"] as J | undefined)?.schema);
  const metadata = deref(spec, (body?.properties as J | undefined)?.metadata);
  const fields = Object.keys(((metadata?.properties ?? {}) as J));
  const functionish = Object.entries(paths)
    .filter(([p]) => /functions|secrets/.test(p))
    .map(([, v]) => JSON.stringify(v))
    .join(" ");
  return {
    legacyCreatePublished: Boolean(legacy),
    legacyCreateDeprecated: legacy?.deprecated === true,
    deployDeclaredResponses: Object.keys(((deploy?.responses ?? {}) as J)).sort(),
    deployMetadataFields: fields.sort(),
    staticPatternsDeclared: fields.includes("static_patterns"),
    sizeLimitMentioned: /size|\bMB\b|megabyte/i.test(functionish),
  };
}
