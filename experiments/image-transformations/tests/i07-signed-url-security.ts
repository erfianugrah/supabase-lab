/**
 * I07 - signed render URL security. Two questions the happy path leaves open:
 *
 * 1. Is the transform covered by the signature? If a leaked signed URL for
 *    width=200 can be edited to width=400 without invalidating it, one leak
 *    is arbitrary variants of that object until expiry.
 * 2. Is expiry enforced on the render surface?
 *
 * A "fail" on I07-tamper is the security finding, not a harness error.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { sign, probe } from "../lib";

const mod: TestModule = {
  id: "I07",
  title: "Signed render URL security",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const host = `https://${ctx.ref}.supabase.co/storage/v1`;

    const signed = await sign(ctx, "priv/small.png", 600, { width: 200, height: 200 });
    const untampered = await probe(`${host}${signed}`);
    const tamperedUrl = `${host}${signed}`.replace("width=200", "width=400").replace("height=200", "height=400");
    const tampered = await probe(tamperedUrl);
    const tamperedServed = tampered.status === 200 && tampered.bytes !== untampered.bytes;
    out.push({
      id: "I07-tamper",
      title: "transform params are covered by the signature",
      status: tamperedServed ? "fail" : "pass",
      detail: tamperedServed
        ? "FINDING: editing width/height on a signed render URL is honored - a leaked URL yields arbitrary variants until expiry"
        : "tampered params rejected or ignored",
      measurements: {
        untampered_status: untampered.status,
        untampered_bytes: untampered.bytes,
        tampered_status: tampered.status,
        tampered_bytes: tampered.bytes,
      },
    });

    const shortLived = await sign(ctx, "priv/small.png", 1, { width: 200 });
    await new Promise((r) => setTimeout(r, 3000));
    const expired = await probe(`${host}${shortLived}`);
    out.push({
      id: "I07-expiry",
      title: "expired signed render URL is rejected",
      status: expired.status === 400 || expired.status === 403 ? "pass" : "fail",
      measurements: { status: expired.status },
    });

    return out;
  },
};
export default mod;
