/**
 * PG00 - what each image is: server_version, default database locale, the
 * four extensions the other modules exercise (installed or available version),
 * the build of each extension library, and whether amcheck has a GiST check.
 *
 * Read-only. Starts the old and the new image of each pair on its own empty
 * data directory, one at a time. The library checksums say whether the extension
 * binary differs between the two images; they say nothing about WHY it does.
 *
 * Not settled by this module: anything about a hosted project (the hosted
 * image may differ from the public one in tag, settings and database locale).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { one, pairs, skipReason, tryq, withRig, type Rig } from "../lib/rig";

const ID = "PG00";

async function facts(r: Rig, which: "old" | "new"): Promise<Record<string, string | number>> {
  await r.start(which);
  const m: Record<string, string | number> = {};
  await r.withClient("supabase_admin", "postgres", async (c) => {
    m[`${which}_image_tag`] = r.tag;
    m[`${which}_server_version`] = await one(c, "select current_setting('server_version')");
    const d = (
      await c.query(
        "select datlocprovider::text p, datcollate c, pg_encoding_to_char(encoding) e from pg_database where datname = 'postgres'",
      )
    ).rows[0];
    m[`${which}_db_locale_provider`] = d.p === "i" ? "icu" : d.p === "c" ? "libc" : d.p;
    m[`${which}_db_collate`] = d.c;
    m[`${which}_db_encoding`] = d.e;
    for (const ext of ["amcheck", "btree_gist", "intarray", "ltree", "pgcrypto"]) {
      m[`${which}_ext_${ext}_default_version`] = await one(
        c,
        "select coalesce((select default_version from pg_available_extensions where name = $1), '(absent)')",
        [ext],
      );
    }
    m[`${which}_has_gist_index_check`] = (await one<boolean>(c, "select to_regproc('gist_index_check') is not null"))
      ? "yes"
      : "no (amcheck here only knows bt_index_check)";
    const sup = await tryq(c, "select rolsuper from pg_roles where rolname = 'postgres'");
    m[`${which}_postgres_role_is_superuser`] = String(sup.rows[0]?.rolsuper);
  });
  // intarray's library is named _int
  for (const lib of ["ltree", "btree_gist", "pgcrypto", "amcheck", "_int"]) {
    const o = await r.sh(`md5sum "$(pg_config --pkglibdir)/${lib}.so" | cut -c1-12`);
    m[`${which}_lib_${lib}_md5_12`] = o.out;
  }
  await r.stop();
  return m;
}

const mod: TestModule = {
  id: ID,
  title: "Image inventory: versions, database locale, extension builds",
  where: "local",
  requires: [],
  async run(_ctx: Ctx): Promise<TestResult[]> {
    const why = await skipReason();
    if (why) return [{ id: ID, title: this.title, status: "skip", detail: why }];
    const out: TestResult[] = [];
    for (const p of pairs()) {
      const id = `${ID}-pg${p.major}`;
      try {
        const m = await withRig(p, async (r) => {
          const o = await facts(r, "old");
          const n = await facts(r, "new");
          return { ...o, ...n };
        });
        for (const lib of ["ltree", "btree_gist", "pgcrypto"]) {
          m[`lib_${lib}_differs`] = m[`old_lib_${lib}_md5_12`] !== m[`new_lib_${lib}_md5_12`] ? "yes" : "no";
        }
        out.push({
          id,
          title: `${this.title} (PG ${p.major}: ${p.oldTag} -> ${p.newTag})`,
          status: "info",
          detail: `${m.old_server_version} -> ${m.new_server_version}`,
          measurements: m,
        });
      } catch (e) {
        out.push({ id, title: this.title, status: "fail", detail: `threw: ${(e as Error).message}` });
      }
    }
    return out;
  },
};

export default mod;
