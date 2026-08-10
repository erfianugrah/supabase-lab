/**
 * G01 - is there a graph engine in this Postgres, and what IS there instead?
 *
 * THE CLAIM THIS REPLACES. The available answer today is a documentation
 * search: grepping the Supabase docs for Apache AGE, graph database, knowledge
 * graph and entity extraction returns zero hits. That is a fact about the
 * DOCUMENTATION. The question asked was about the PLATFORM, and the gap between
 * those two has burned this repo before - platform-facts F05 records an
 * investigation that concluded an API could not do something after probing only
 * the paths named after it, when the lever sat on a differently-named path.
 *
 * `pg_available_extensions` is the platform's own answer and it outranks a doc
 * grep in BOTH directions: it can surface something nobody wrote up, and its
 * silence is authoritative rather than editorial.
 *
 * WHAT THIS TEST DOES NOT DO. It does not assert that AGE is absent. Encoding
 * the expected answer as the pass condition would make the test a mirror of the
 * belief that motivated it, and it would go red the day the platform adds the
 * extension - which is precisely the day someone needs to be told. It asserts
 * that the catalogue was READ, and records what was in it. The verdict is a
 * measurement, so `pvlab --diff` reports the day it changes.
 *
 * THE NAME COLLISION IS THE OTHER HALF OF THE JOB. `pg_graphql` is present on
 * every Supabase project and shares nothing with a graph database but the word
 * "graph" - it is a GraphQL API over relational tables. Anyone grepping an
 * extension list for /graph/ finds it and reports the question closed. The test
 * therefore classifies rather than pattern-matches, and records the collision
 * explicitly so the report cannot be misread the way the list can.
 *
 * Read-only.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { instanceSize, q } from "../lib/pg";

/**
 * Two DIFFERENT capabilities, kept apart because collapsing them is what makes
 * this question get answered wrongly in both directions.
 *
 * A property-graph STORE is what "graph database" means in the Neo4j sense: a
 * node/edge storage model with properties and a traversal language (Cypher,
 * Gremlin). Nothing else substitutes for it if the requirement is literally
 * "drop in a graph database".
 *
 * A graph-ALGORITHM library is a different thing that answers most of the same
 * QUESTIONS: shortest path, reachability, components, centrality - computed
 * over ordinary relational edge tables. "Who is connected to whom, and how"
 * needs the algorithms, not the storage model.
 */
const PROPERTY_GRAPH_STORES = ["age", "agensgraph", "apache_age", "sqlg"];
const GRAPH_ALGORITHM_LIBS = ["pgrouting"];

/**
 * Matched by EXACT name, and the reason is a false negative this test caught in
 * its own authoring. A hand-written probe used `name ~* 'age|graph|route|...'`
 * and reported no graph capability - because "pgrouting" contains "routi", not
 * "route". The regex was one letter from correct and the conclusion drawn from
 * it ("nothing available") was about to be written up. A substring match is
 * also wrong in the other direction: /graph/ collects pg_graphql and /age/
 * collects pageinspect and storage, both present here.
 */
const GRAPH_ENGINES = [...PROPERTY_GRAPH_STORES, ...GRAPH_ALGORITHM_LIBS];

/**
 * Named because they are what a graph engine's absence has to be answered
 * WITH. Nobody is served by "no AGE" on its own; the useful output is the
 * shape of the alternative that does exist.
 */
const RELEVANT = [
  "vector", // similarity search over embeddings
  "pg_trgm", // fuzzy name matching - entity resolution's cheapest tool
  "fuzzystrmatch", // levenshtein/soundex, same job
  "unaccent",
  "ltree", // hierarchies ONLY - a tree is not a graph, see below
  "rum", // richer inverted index than gin for text
  "pgroonga", // full-text, CJK-capable
  "pgmq", // the queue the documented ingestion pattern is built on
  "pg_cron",
  "pg_net",
  "http",
  "pg_partman", // a 25-year corpus is a partitioning problem
  "hypopg", // index planning without paying to build
  "pgstattuple", // bloat measurement, needed to read X03's numbers honestly
  "pg_graphql", // the collision
];

const mod: TestModule = {
  id: "G01",
  title: "Graph-engine availability in the managed extension catalogue",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const all = await q(
      ctx,
      "select name, default_version, coalesce(installed_version,'') from pg_available_extensions order by name",
    );
    if (!all.ok) {
      return [
        {
          id: "G01",
          title: mod.title,
          status: "fail",
          detail: "could not read pg_available_extensions",
          evidence: all.raw.slice(0, 2000),
        },
      ];
    }

    const names = all.rows.map((r) => r[0] ?? "");
    const versionOf = new Map(all.rows.map((r) => [r[0] ?? "", r[1] ?? ""]));

    const engines = GRAPH_ENGINES.filter((g) => names.includes(g));
    const stores = PROPERTY_GRAPH_STORES.filter((g) => names.includes(g));
    const algos = GRAPH_ALGORITHM_LIBS.filter((g) => names.includes(g));
    const present = RELEVANT.filter((r) => names.includes(r));
    const absent = RELEVANT.filter((r) => !names.includes(r));

    // What an algorithm library costs to adopt. pgrouting declares a hard
    // dependency on postgis, so "available" means a 3.3.x geospatial stack gets
    // installed alongside it - which is a real answer to "what does this pull
    // into my database", not a footnote.
    const deps = await q(
      ctx,
      `select ae.name, coalesce(array_to_string(v.requires,','),'')
         from pg_available_extensions ae
         join pg_available_extension_versions v
           on v.name = ae.name and v.version = ae.default_version
        where ae.name = any(array['${GRAPH_ENGINES.join("','")}'])`,
    );
    const requires = new Map(deps.ok ? deps.rows.map((r) => [r[0] ?? "", r[1] ?? ""]) : []);

    // Anything whose NAME suggests graph capability, so the report shows what a
    // careless grep would have collected and why it was rejected.
    const nameLooksGraphy = names.filter((n) => /graph|cypher|gremlin|neo/i.test(n));

    const measurements: Record<string, number | string> = {
      extensions_total: names.length,
      property_graph_stores: stores.length ? stores.join(",") : "none",
      graph_algorithm_libs: algos.length
        ? algos.map((a) => `${a}@${versionOf.get(a)}`).join(",")
        : "none",
      graph_lib_requires: algos.map((a) => requires.get(a) || "-").join(",") || "none",
      name_collisions: nameLooksGraphy.join(",") || "none",
      instance_size: instanceSize(),
    };
    for (const p of present) measurements[`ext_${p}`] = versionOf.get(p) ?? "?";

    // Deliberately two clauses, because the one-line answer is two facts and
    // reporting either alone misleads. "No graph database" overstates the gap;
    // "graph extension available" overstates the capability.
    const verdict =
      `property-graph store: ${stores.length ? stores.join(", ") : "NONE available"}; ` +
      `graph-algorithm library: ${
        algos.length
          ? `${algos.map((a) => `${a}@${versionOf.get(a)}`).join(", ")} (requires ${algos.map((a) => requires.get(a) || "-").join(",")})`
          : "NONE available"
      }`;

    return [
      {
        id: "G01",
        title: mod.title,
        // `info`, not `pass`. There is no correct value for a platform's
        // extension catalogue, and asserting one manufactures a failure the
        // day the platform legitimately changes - the reasoning platform-facts
        // applies to prices. The gate is that the catalogue was read at all.
        status: "info",
        detail:
          `${verdict}; ltree=${names.includes("ltree") ? "yes (hierarchy only, not a graph)" : "no"}; ` +
          `pg_graphql=${names.includes("pg_graphql") ? "present - GraphQL API over tables, NOT a graph DB" : "absent"}`,
        measurements,
        evidence:
          `graph-engine candidates checked: ${GRAPH_ENGINES.join(", ")}\n` +
          `found: ${engines.join(", ") || "(none)"}\n\n` +
          `relevant-and-present: ${present.map((p) => `${p}@${versionOf.get(p)}`).join(", ")}\n` +
          `relevant-and-absent: ${absent.join(", ") || "(none)"}\n\n` +
          `full catalogue (${names.length}):\n${names.join(" ")}`,
      },
    ];
  },
};

export default mod;
