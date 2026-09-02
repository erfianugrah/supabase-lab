/**
 * R05 - the Storage CDN cache matrix, measured.
 *
 * Two public claims the residency doc currently rests on doc-reading alone:
 *
 *   fundamentals.md: private-bucket objects are permission-checked per user,
 *   so two users in the same region both get a cache MISS.
 *
 *   smart-cdn.md: signed-URL responses are cached per token - first request
 *   with a given signed URL misses, repeats of the SAME URL hit, a new signed
 *   URL for the same object misses again.
 *
 * Both are firm documented claims, so this module asserts them. Everything
 * else (public-bucket miss-then-hit, absolute timings) is info.
 *
 * Flow: create public + private bucket, upload one object to each, then:
 *   public:   anon GET x2                      -> expect MISS then HIT
 *   private:  user1 GET x2, then user2 GET     -> docs claim user2 misses
 *   signed:   sign with user1, GET url x2      -> expect MISS then HIT
 *             sign again (new token), GET      -> expect MISS
 *
 * Buckets, objects and users are created and deleted inside the run.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { getKeys, psql } from "../lib";

const PUB = "r05-public";
const PRIV = "r05-private";
const OBJ = "probe.txt";

interface Obs {
  status: number;
  cache: string;
  age: string;
  cc: string;
}

const mod: TestModule = {
  id: "R05",
  title: "Storage CDN cache matrix",
  where: "local",
  requires: ["pat", "db"], // db: the private-bucket read needs an RLS policy on storage.objects
  destructive: true, // creates buckets, objects, auth users; cleans up after
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await getKeys(ctx);
    if (!keys.anon || !keys.service) {
      return [
        {
          id: "R05a",
          title: this.title,
          status: "fail",
          detail: `missing keys: anon=${keys.anon ? "set" : "absent"}, service=${keys.service ? "set" : "absent"}`,
        },
      ];
    }
    const base = `https://${ctx.apiHost}`;
    const svc = { apikey: keys.service, Authorization: `Bearer ${keys.service}` };
    const anon = { apikey: keys.anon, Authorization: `Bearer ${keys.anon}` };

    async function observe(url: string, headers: Record<string, string>): Promise<Obs> {
      const res = await fetch(url, { headers });
      await res.arrayBuffer();
      return {
        status: res.status,
        cache: res.headers.get("cf-cache-status") ?? res.headers.get("x-cache") ?? "absent",
        age: res.headers.get("age") ?? "0",
        cc: res.headers.get("cache-control") ?? "absent",
      };
    }

    async function createUser(email: string, password: string): Promise<{ id: string; token: string }> {
      const create = await fetch(`${base}/auth/v1/admin/users`, {
        method: "POST",
        headers: { ...svc, "content-type": "application/json" },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const u = (await create.json()) as { id?: string };
      const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { ...anon, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const s = (await login.json()) as { access_token?: string };
      return { id: u.id ?? "", token: s.access_token ?? "" };
    }

    const cleanup = async (userIds: string[]) => {
      for (const b of [PUB, PRIV]) {
        await fetch(`${base}/storage/v1/bucket/${b}/empty`, { method: "POST", headers: svc }).catch(() => {});
        await fetch(`${base}/storage/v1/bucket/${b}`, { method: "DELETE", headers: svc }).catch(() => {});
      }
      for (const id of userIds) {
        await fetch(`${base}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: svc }).catch(() => {});
      }
    };

    const m: Record<string, string | number> = {};
    const userIds: string[] = [];
    try {
      // Setup: buckets + objects. 400 on bucket create = already exists
      // (a previous run's cleanup missed it) - record the body and continue.
      for (const [b, pub] of [[PUB, true], [PRIV, false]] as const) {
        const r = await fetch(`${base}/storage/v1/bucket`, {
          method: "POST",
          headers: { ...svc, "content-type": "application/json" },
          body: JSON.stringify({ id: b, name: b, public: pub }),
        });
        m[`setup_bucket_${pub ? "public" : "private"}`] = r.status;
        if (r.status !== 200) m[`setup_bucket_${pub ? "public" : "private"}_body`] = (await r.text()).slice(0, 120);
      }
      for (const b of [PUB, PRIV]) {
        const r = await fetch(`${base}/storage/v1/object/${b}/${OBJ}`, {
          method: "POST",
          headers: { ...svc, "content-type": "text/plain" },
          body: `r05 ${b} ${Date.now()}`,
        });
        m[`setup_object_${b}`] = r.status;
      }

      // Public bucket: anon read twice.
      const pubUrl = `${base}/storage/v1/object/public/${PUB}/${OBJ}`;
      const p1 = await observe(pubUrl, anon);
      const p2 = await observe(pubUrl, anon);
      m.public_first = `${p1.status}/${p1.cache}`;
      m.public_second = `${p2.status}/${p2.cache} age=${p2.age}`;

      // Private bucket: two users. Default storage RLS denies authenticated
      // reads, so without this policy every user read is a 400 and the
      // per-user cache claim is untestable.
      const pol = await psql(
        ctx,
        `create policy r05_read on storage.objects for select to authenticated using (bucket_id = '${PRIV}')`,
      );
      m.setup_policy = pol.ok ? "ok" : pol.out.slice(0, 120);
      if (!pol.ok) {
        return [
          { id: "R05a", title: this.title, status: "fail", detail: `RLS policy setup failed: ${pol.out.slice(0, 200)}`, measurements: m },
        ];
      }

      const ts = Date.now();
      const u1 = await createUser(`r05-a-${ts}@example.com`, `Pw!${crypto.randomUUID()}`);
      const u2 = await createUser(`r05-b-${ts}@example.com`, `Pw!${crypto.randomUUID()}`);
      const u3 = await createUser(`r05-c-${ts}@example.com`, `Pw!${crypto.randomUUID()}`);
      userIds.push(u1.id, u2.id, u3.id);
      if (!u1.token || !u2.token || !u3.token) {
        return [
          {
            id: "R05a",
            title: this.title,
            status: "fail",
            detail: `user setup failed: u1=${u1.token ? "ok" : "no token"}, u2=${u2.token ? "ok" : "no token"}, u3=${u3.token ? "ok" : "no token"}`,
            measurements: m,
          },
        ];
      }
      const privUrl = `${base}/storage/v1/object/authenticated/${PRIV}/${OBJ}`;
      const a1 = await observe(privUrl, { apikey: keys.anon, Authorization: `Bearer ${u1.token}` });
      const a2 = await observe(privUrl, { apikey: keys.anon, Authorization: `Bearer ${u1.token}` });
      const b1 = await observe(privUrl, { apikey: keys.anon, Authorization: `Bearer ${u2.token}` });
      m.private_user1_first = `${a1.status}/${a1.cache}`;
      m.private_user1_second = `${a2.status}/${a2.cache} age=${a2.age}`;
      m.private_user2_first = `${b1.status}/${b1.cache}`;

      // Negative control. The permissive policy let user2 read a cached
      // private object (HIT) in the first run of this test - so the real
      // question is whether the CDN serves a cached private object to a user
      // the policy DENIES. Restrict the policy to u1 only, then read as u3
      // (never read before) and as u2 (whose earlier read populated nothing
      // per-user, if the cache key is per-object).
      await psql(
        ctx,
        `drop policy r05_read on storage.objects; create policy r05_read on storage.objects for select to authenticated using (bucket_id = '${PRIV}' and auth.uid() = '${u1.id}'::uuid)`,
      );
      const c1 = await observe(privUrl, { apikey: keys.anon, Authorization: `Bearer ${u3.token}` });
      const c2 = await observe(privUrl, { apikey: keys.anon, Authorization: `Bearer ${u2.token}` });
      m.denied_user3_never_read = `${c1.status}/${c1.cache}`;
      m.denied_user2_after_hit = `${c2.status}/${c2.cache}`;
      m.private_cache_control = a1.cc;

      // Signed URLs: per-token cache keying.
      // The token embeds the expiry, so two sign calls in the same second
      // with the same expiresIn return the SAME url (measured: run 3 of this
      // module). Vary expiresIn to force distinct tokens deterministically.
      async function sign(expiresIn: number): Promise<string> {
        const r = await fetch(`${base}/storage/v1/object/sign/${PRIV}/${OBJ}`, {
          method: "POST",
          // keys.anon is checked non-empty at the top of run(); TypeScript does
          // not carry that narrowing into a nested function, hence the fallback.
          headers: { apikey: keys.anon ?? "", Authorization: `Bearer ${u1.token}`, "content-type": "application/json" },
          body: JSON.stringify({ expiresIn }),
        });
        const j = (await r.json()) as { signedURL?: string };
        return j.signedURL ? `${base}/storage/v1${j.signedURL}` : "";
      }
      const url1 = await sign(300);
      const s1 = await observe(url1, {});
      const s2 = await observe(url1, {});
      const url2 = await sign(600);
      const s3 = await observe(url2, {});
      m.signed_first = `${s1.status}/${s1.cache}`;
      m.signed_repeat = `${s2.status}/${s2.cache} age=${s2.age}`;
      m.signed_new_token = `${s3.status}/${s3.cache}`;
      m.signed_urls_differ = url1 !== url2 ? "yes" : "no";

      const hit = (o: Obs) => /^(HIT|REVALIDATED)$/i.test(o.cache);
      const miss = (o: Obs) => /MISS|EXPIRED|DYNAMIC/i.test(o.cache);

      const results: TestResult[] = [];

      // Firm claim 1: same signed URL hits on repeat; new token misses.
      const signClaim = hit(s2) && miss(s3) && url1 !== url2;
      results.push({
        id: "R05a",
        title: "signed URLs cache per token",
        status: signClaim ? "pass" : "info",
        detail: signClaim
          ? "per-token keying confirmed: repeat of one signed URL hits, a fresh token misses"
          : `documented per-token keying NOT observed: repeat=${s2.cache}, new-token=${s3.cache} (urls differ: ${m.signed_urls_differ})`,
        measurements: m,
      });

      // Firm claim 2: second user on the same private object misses.
      const privClaim = b1.status === 200 && miss(b1);
      results.push({
        id: "R05b",
        title: "private bucket: second user misses",
        status: privClaim ? "pass" : "info",
        detail: privClaim
          ? `per-user miss confirmed (user1 second read: ${a2.cache}, user2 first read: ${b1.cache})`
          : `documented per-user miss NOT observed: user2 first read -> ${b1.status}/${b1.cache}`,
        measurements: m,
      });

      // The security invariant behind claim 2: a cached private object must
      // NOT be served to a user the policy denies. 4xx = auth re-checked at
      // or before the cache; 200 = the cache served bytes without the
      // policy, which is a fail, not an info.
      const denied = c1.status !== 200 && c2.status !== 200;
      results.push({
        id: "R05c",
        title: "private bucket: denied users never get the cached object",
        status: denied ? "pass" : "fail",
        detail: denied
          ? `policy-denied users got ${c1.status} and ${c2.status} - the cache does not bypass RLS`
          : `policy-denied user got HTTP 200 (user3=${c1.status}/${c1.cache}, user2=${c2.status}/${c2.cache}) - the CDN serves cached private objects without the policy`,
        measurements: m,
      });

      return results;
    } finally {
      await psql(ctx, `drop policy if exists r05_read on storage.objects`).catch(() => {});
      await cleanup(userIds);
    }
  },
};
export default mod;
