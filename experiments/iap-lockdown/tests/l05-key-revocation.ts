/**
 * L05 - key revocation: what a project with no browser-usable keys answers.
 *
 * The IAP-as-proxy pattern only becomes a real gate when the keys that could
 * bypass the proxy stop working.
 *
 *   L05a - GET /api-keys: record both key generations present.
 *   L05b - PUT /api-keys/legacy?enabled=false: poll to effect, inventory with
 *          the legacy anon JWT (should refuse) and with the publishable key
 *          (does the new generation still work with legacy off?).
 *   L05c - keyless inventory: no credential at all.
 *   L05e - governance row: POST /api-keys mints a fresh key at any time with
 *          the PAT, so "revoked" is a posture the control plane can always
 *          reopen. Mint + delete one as the proof.
 *
 * DESTRUCTIVE: disables legacy keys mid-run; the finally re-enables them and
 * VERIFIES recovery. A project left with legacy keys disabled would break
 * every sibling module that follows, so a failed restore shouts in capitals.
 * (The project is also destroyed at end of run, bounding the blast radius.)
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, inventory, toMeasurements, waitFor, TABLE } from "../lib/inventory.js";

async function legacyEnabled(ctx: Ctx, enabled: boolean) {
  return mgmt(ctx, "PUT", `/projects/${ctx.ref}/api-keys/legacy?enabled=${enabled}`);
}
async function anonReadOk(ctx: Ctx, anonJwt: string): Promise<boolean> {
  const r = await http(`https://${ctx.apiHost}/rest/v1/${TABLE}?select=id&limit=1`, { key: anonJwt });
  return r.status === 200;
}

const mod: TestModule = {
  id: "L05",
  title: "key revocation: legacy off, what a keyless project answers, control-plane re-mint",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const results: TestResult[] = [];

    const listed = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
    const rows = Array.isArray(listed.json) ? (listed.json as { name?: string; type?: string }[]) : [];
    results.push({
      id: "L05a",
      title: "key generations present on the project",
      status: listed.status === 200 ? "info" : "fail",
      detail: rows.map((k) => `${k.name ?? k.type}`).join(", ") || `GET api-keys http ${listed.status}`,
      measurements: {
        legacy_present: String(rows.some((k) => k.name === "anon" || k.name === "service_role")),
        publishable_present: String(Boolean(keys.publishable?.api_key)),
      },
    });

    let disabled = false;
    try {
      const off = await legacyEnabled(ctx, false);
      results.push({
        id: "L05b0",
        title: "PUT api-keys/legacy?enabled=false",
        status: off.status < 300 ? "pass" : "fail",
        measurements: { patch_status: off.status },
        evidence: off.status < 300 ? undefined : off.text.slice(0, 300),
      });
      if (off.status < 300) {
        disabled = true;
        const took = await waitFor(async () => !(await anonReadOk(ctx, keys.anonJwt)), 60_000);

        const invLegacy = await inventory(ctx, keys.anonJwt, "");
        results.push({
          id: "L05b",
          title: "legacy anon JWT after revocation",
          status: took.ok ? "pass" : "fail",
          detail: `after ${took.elapsedS}s the legacy anon key is ${took.ok ? "refused" : "STILL ACCEPTED"} across the inventory`,
          measurements: toMeasurements(invLegacy, "legacy_off"),
        });

        if (keys.publishable?.api_key) {
          const invPub = await inventory(ctx, keys.publishable.api_key, "");
          const restRow = invPub.find((r) => r.surface === "rest_table");
          results.push({
            id: "L05b2",
            title: "publishable key while legacy is disabled",
            status: "info",
            detail: `publishable rest_table=${restRow?.status} ${restRow?.code} - do the two generations share a disable, or is legacy independent?`,
            measurements: toMeasurements(invPub, "pub_legacyoff"),
          });
        }

        const invNone = await inventory(ctx, "", "");
        results.push({
          id: "L05c",
          title: "keyless inventory (no credential)",
          status: "info",
          detail: invNone.map((r) => `${r.surface}=${r.status}`).join(" "),
          measurements: toMeasurements(invNone, "keyless"),
        });
      }
    } finally {
      // Re-enable legacy keys, with retries, and VERIFY the anon read recovers.
      let restored = false;
      let lastStatus = 0;
      for (let i = 0; i < 5 && !restored; i++) {
        const on = await legacyEnabled(ctx, true);
        lastStatus = on.status;
        if (on.status < 300) {
          const back = await waitFor(() => anonReadOk(ctx, keys.anonJwt), 60_000);
          restored = back.ok;
        }
        if (!restored) await new Promise((r) => setTimeout(r, 5000));
      }
      results.push({
        id: "L05z",
        title: "restore legacy keys",
        status: restored || !disabled ? "pass" : "fail",
        detail: !disabled
          ? "legacy keys were never disabled - nothing to restore"
          : restored
            ? "legacy keys re-enabled and anon read confirmed working again"
            : `RESTORE FAILED (last PUT ${lastStatus}) - PROJECT LEFT WITH LEGACY KEYS DISABLED; it is destroyed at end of run but siblings after L05 will skip`,
        measurements: { restore_status: lastStatus, restored: String(restored) },
      });
    }

    // L05e - governance: the control plane can always mint a new key.
    const mint = await mgmt(ctx, "POST", `/projects/${ctx.ref}/api-keys?reveal=true`, {
      type: "publishable",
      name: `iap_l05_ephemeral_${Date.now()}`,
    });
    const mintedId = (mint.json as { id?: string })?.id;
    if (mintedId) await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/api-keys/${mintedId}`);
    results.push({
      id: "L05e",
      title: "control plane can re-mint a key at any time",
      status: "info",
      detail:
        mint.status < 300
          ? `minted a fresh publishable key (${mint.status}) and deleted it - "revoked" is a posture the PAT always reopens`
          : `mint returned ${mint.status} ${mint.text.slice(0, 120)}`,
      measurements: { mint_status: mint.status },
    });

    return results;
  },
};
export default mod;
