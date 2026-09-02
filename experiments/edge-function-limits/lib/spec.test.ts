import { describe, expect, test } from "bun:test";
import { deployContract, patternRejectsPrefix, secretsContract } from "./spec";

/** The shape the published document had on 2026-09-02, reduced to what the readers touch. */
const FIXTURE = {
  paths: {
    "/v1/projects/{ref}/secrets": {
      post: {
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateSecretBody" } } },
        },
      },
    },
    "/v1/projects/{ref}/functions": { post: { deprecated: true } },
    "/v1/projects/{ref}/functions/deploy": {
      post: {
        requestBody: {
          content: { "multipart/form-data": { schema: { $ref: "#/components/schemas/FunctionDeployBody" } } },
        },
        responses: { "201": {}, "401": {}, "402": {}, "403": {}, "429": {}, "500": {} },
      },
    },
  },
  components: {
    schemas: {
      CreateSecretBody: {
        maxItems: 100,
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 256, pattern: "^(?!SUPABASE_).*" },
            value: { type: "string", maxLength: 24576 },
          },
        },
      },
      FunctionDeployBody: {
        type: "object",
        properties: {
          file: { type: "array" },
          metadata: {
            type: "object",
            properties: {
              entrypoint_path: {},
              import_map_path: {},
              static_patterns: {},
              verify_jwt: {},
              name: {},
            },
          },
        },
      },
    },
  },
};

describe("secretsContract", () => {
  test("reads the four declared secrets limits through the $ref", () => {
    expect(secretsContract(FIXTURE)).toEqual({
      maxItems: 100,
      nameMaxLength: 256,
      namePattern: "^(?!SUPABASE_).*",
      valueMaxLength: 24576,
    });
  });

  test("a document without the secrets path yields an empty contract rather than throwing", () => {
    expect(secretsContract({ paths: {} })).toEqual({});
  });

  test("the declared name pattern rejects the reserved prefix and accepts an ordinary name", () => {
    expect(patternRejectsPrefix("^(?!SUPABASE_).*", "SUPABASE_")).toBe(true);
    expect(patternRejectsPrefix(".*", "SUPABASE_")).toBe(false);
    expect(patternRejectsPrefix(undefined, "SUPABASE_")).toBe(false);
  });
});

describe("deployContract", () => {
  test("legacy create is published but deprecated; multipart deploy declares 429 and not 413", () => {
    const c = deployContract(FIXTURE);
    expect(c.legacyCreatePublished).toBe(true);
    expect(c.legacyCreateDeprecated).toBe(true);
    expect(c.deployDeclaredResponses).toContain("429");
    expect(c.deployDeclaredResponses).not.toContain("413");
  });

  test("static_patterns is part of the API deploy contract even though the docs say the API cannot deploy static files", () => {
    expect(deployContract(FIXTURE).staticPatternsDeclared).toBe(true);
  });

  test("the size ceiling is not expressed anywhere in the functions/secrets contract", () => {
    expect(deployContract(FIXTURE).sizeLimitMentioned).toBe(false);
  });
});
