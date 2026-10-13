import { describe, expect, test } from "bun:test";
import { graphqlState } from "./graphql";

describe("graphqlState", () => {
  test("a served { __typename } is ok:<type>", () => {
    expect(graphqlState(200, '{"data":{"__typename":"Query"}}')).toBe("200 ok:Query");
  });

  test("pg_graphql absent: 200 with an errors envelope is not served (DD02e)", () => {
    expect(graphqlState(200, '{"data":null,"errors":[{"message":"pg_graphql extension is not enabled."}]}')).toBe(
      "200 pg_graphql extension is not enabled.",
    );
  });

  test("graphql_public not exposed: the PostgREST code", () => {
    expect(
      graphqlState(406, '{"code":"PGRST106","details":null,"hint":null,"message":"The schema must be one of the following: public"}'),
    ).toBe("406 PGRST106");
  });

  test("a message-only body, a non-JSON body and an empty body", () => {
    expect(graphqlState(401, '{"message":"Invalid API key"}')).toBe("401 Invalid API key");
    expect(graphqlState(502, "<html>bad gateway</html>")).toBe("502 <html>bad gateway</html>");
    expect(graphqlState(204, "")).toBe("204");
    expect(graphqlState(200, "null")).toBe("200");
  });
});
