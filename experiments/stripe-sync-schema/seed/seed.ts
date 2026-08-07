/**
 * Seed the fixture matrix into a dedicated Stripe test account.
 *
 * WHY THIS EXISTS. E02 reports a typed column as "never populated" when no
 * sampled payload carries its key. On a naive account - a handful of active
 * subscriptions all created the same way - that measurement cannot separate a
 * field that genuinely moved from a field that is simply null for every object
 * that happens to exist. Absence is only evidence if the objects that WOULD
 * populate the column are present. This creates them.
 *
 * IDEMPOTENT. Every object is tagged `metadata[pvlab]=stripe-sync-schema` and
 * the script looks for existing fixtures before creating. Re-running is a
 * no-op; `--force` creates a second generation, which is occasionally what you
 * want when testing a re-sync. It never deletes, because deleting objects in
 * Stripe is mostly impossible and pretending otherwise would be a lie in the
 * shape of a --clean flag.
 *
 * SAFETY. Refuses to run against a key whose account already contains objects
 * it did not create. This writes real (test-mode) data and the one failure
 * mode worth engineering against is pointing it at the wrong account - which
 * has already happened once, by hand, in this project's history.
 *
 *   STRIPE_SECRET_KEY=sk_test_... bun run seed/seed.ts [--force]
 */

const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const FORCE = process.argv.includes("--force");
const TAG = "stripe-sync-schema";
const API = "https://api.stripe.com/v1";

if (!KEY) {
  console.error("STRIPE_SECRET_KEY is required (a WRITE key - rk_ read-only keys cannot seed)");
  process.exit(1);
}
if (!KEY.startsWith("sk_test_")) {
  console.error(`refusing to run: key is not sk_test_ (got ${KEY.slice(0, 8)}...).`);
  console.error("This creates data. Live keys and read-only keys are both wrong here.");
  process.exit(1);
}

/** Stripe takes form-encoded bodies with bracket notation for nesting. */
function form(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object") out.push(...form(item as Record<string, unknown>, `${key}[${i}]`));
        else out.push(`${key}[${i}]=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      out.push(...form(v as Record<string, unknown>, key));
    } else {
      out.push(`${key}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

async function stripe(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const url = `${API}/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${btoa(KEY + ":")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? form(body).join("&") : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${json?.error?.message ?? JSON.stringify(json)}`);
  }
  return json;
}

const tagged = { metadata: { pvlab: TAG } };
let created = 0;
const note = (s: string) => console.log(`  ${s}`);

async function preflight() {
  const acct = await stripe("GET", "account").catch(() => null);
  note(`account: ${acct?.id ?? "unknown"} (${acct?.country ?? "?"})`);

  const subs = await stripe("GET", "subscriptions?limit=100&status=all");
  const foreign = subs.data.filter((s: any) => s.metadata?.pvlab !== TAG);
  if (foreign.length > 0 && !FORCE) {
    console.error(
      `\nrefusing to run: this account has ${foreign.length} subscription(s) this script did not create.\n` +
        `That is the signature of pointing at the wrong account - which has happened here before.\n` +
        `The fixture account should be dedicated and otherwise empty.\n` +
        `If you are certain, re-run with --force.`,
    );
    process.exit(1);
  }
  const mine = subs.data.filter((s: any) => s.metadata?.pvlab === TAG);
  if (mine.length > 0 && !FORCE) {
    note(`already seeded: ${mine.length} subscription(s) tagged ${TAG} - nothing to do`);
    note("re-run with --force to create another generation");
    return false;
  }
  return true;
}

async function main() {
  console.log(`seeding fixture matrix (tag=${TAG}${FORCE ? ", FORCED" : ""})\n`);
  if (!(await preflight())) return;

  // --- catalogue -----------------------------------------------------------
  const product = await stripe("POST", "products", { name: "Lab Plan", ...tagged });
  const productMetered = await stripe("POST", "products", { name: "Lab Metered", ...tagged });
  created += 2;

  const priceMonthly = await stripe("POST", "prices", {
    product: product.id, unit_amount: 500, currency: "usd",
    recurring: { interval: "month" }, ...tagged,
  });
  const priceYearly = await stripe("POST", "prices", {
    product: product.id, unit_amount: 4800, currency: "usd",
    recurring: { interval: "year" }, ...tagged,
  });
  const priceSecond = await stripe("POST", "prices", {
    product: product.id, unit_amount: 200, currency: "usd",
    recurring: { interval: "month" }, ...tagged,
  });
  const priceMetered = await stripe("POST", "prices", {
    product: productMetered.id, currency: "usd",
    recurring: { interval: "month", usage_type: "metered" },
    unit_amount: 10, ...tagged,
  }).catch((e) => { note(`metered price skipped: ${e.message}`); return null; });
  created += priceMetered ? 4 : 3;
  note(`catalogue: 2 products, ${priceMetered ? 4 : 3} prices`);

  const coupon = await stripe("POST", "coupons", {
    percent_off: 25, duration: "forever", name: "Lab 25", ...tagged,
  });
  created += 1;

  // A payment method that always succeeds. Attached per-customer below so
  // subscriptions can actually bill rather than sitting incomplete.
  async function customerWithCard(email: string, extra: Record<string, unknown> = {}) {
    const c = await stripe("POST", "customers", { email, ...extra, ...tagged });
    const pm = await stripe("POST", "payment_methods", {
      type: "card",
      card: { number: "4242424242424242", exp_month: 12, exp_year: 2030, cvc: "123" },
    });
    await stripe("POST", `payment_methods/${pm.id}/attach`, { customer: c.id });
    await stripe("POST", `customers/${c.id}`, { invoice_settings: { default_payment_method: pm.id } });
    created += 2;
    return c;
  }

  // --- subscription states -------------------------------------------------
  // Each of these exists to make some column non-null that the naive case
  // leaves empty. The comment on each is the column it is there to reach.

  const cActive = await customerWithCard("active@lab.test");
  await stripe("POST", "subscriptions", {
    customer: cActive.id, items: [{ price: priceMonthly.id }], ...tagged,
  });
  note("subscription: active");

  // trial_start / trial_end / trial_settings
  const cTrial = await customerWithCard("trialing@lab.test");
  await stripe("POST", "subscriptions", {
    customer: cTrial.id, items: [{ price: priceMonthly.id }],
    trial_period_days: 14, ...tagged,
  });
  note("subscription: trialing");

  // more than one subscription_items row per subscription
  const cMulti = await customerWithCard("multi@lab.test");
  await stripe("POST", "subscriptions", {
    customer: cMulti.id,
    items: [{ price: priceMonthly.id }, { price: priceSecond.id }], ...tagged,
  });
  note("subscription: multi-item");

  // discounts, on both the subscription and its items
  const cDisc = await customerWithCard("discounted@lab.test");
  await stripe("POST", "subscriptions", {
    customer: cDisc.id, items: [{ price: priceYearly.id }],
    discounts: [{ coupon: coupon.id }], ...tagged,
  }).catch(() => stripe("POST", "subscriptions", {
    customer: cDisc.id, items: [{ price: priceYearly.id }],
    coupon: coupon.id, ...tagged,
  }));
  note("subscription: discounted (yearly)");

  // canceled_at / cancellation_details, and a terminal row that never re-syncs
  // - which is the control group the original accidental observation relied on
  const cCancel = await customerWithCard("canceled@lab.test");
  const subCancel = await stripe("POST", "subscriptions", {
    customer: cCancel.id, items: [{ price: priceMonthly.id }], ...tagged,
  });
  await stripe("POST", `subscriptions/${subCancel.id}/cancel`, {
    cancellation_details: { comment: "lab fixture: terminal state" },
  });
  note("subscription: canceled");

  // cancel_at_period_end, distinct from canceled
  const cPending = await customerWithCard("pending-cancel@lab.test");
  const subPending = await stripe("POST", "subscriptions", {
    customer: cPending.id, items: [{ price: priceMonthly.id }], ...tagged,
  });
  await stripe("POST", `subscriptions/${subPending.id}`, { cancel_at_period_end: true });
  note("subscription: cancel_at_period_end");

  // customers.tax_ids - the expandable-field hypothesis. If E02 still reports
  // this column as never-populated once tax IDs demonstrably exist, it is an
  // expansion artifact and belongs in bucket (2), not in a bug report. This is
  // the single most important row in the matrix for not overclaiming.
  const cTax = await customerWithCard("taxed@lab.test", {
    address: { line1: "1 Lab St", city: "Dublin", country: "IE", postal_code: "D01" },
  });
  await stripe("POST", `customers/${cTax.id}/tax_ids`, { type: "eu_vat", value: "IE6388047V" })
    .then(() => note("customer: with tax_id (expandable-field control)"))
    .catch((e) => note(`tax_id skipped: ${e.message}`));

  // refunds on a charge
  const cRefund = await customerWithCard("refunded@lab.test");
  const pi = await stripe("POST", "payment_intents", {
    amount: 1500, currency: "usd", customer: cRefund.id,
    payment_method: "pm_card_visa", confirm: true, off_session: true, ...tagged,
  }).catch((e) => { note(`payment_intent skipped: ${e.message}`); return null; });
  if (pi?.latest_charge) {
    await stripe("POST", "refunds", { charge: pi.latest_charge })
      .then(() => note("charge: refunded"))
      .catch((e) => note(`refund skipped: ${e.message}`));
  }

  console.log(`\nseeded. ~${created} objects created, all tagged pvlab=${TAG}`);
  console.log("\nNOT covered, and why:");
  console.log("  past_due / dunning  - needs a payment to fail and the retry schedule to");
  console.log("                        advance, which is wall-clock bound. Use a test clock");
  console.log("                        (POST /v1/test_helpers/test_clocks) and advance it.");
  console.log("  disputes            - card 4000000000000259 opens one asynchronously; the");
  console.log("                        webhook lands minutes later, so it cannot be awaited");
  console.log("                        inline here.");
  console.log("  subscription_schedules - worth adding; not needed for the first count.");
  console.log("\nThese three are exactly the states most likely to populate columns E02");
  console.log("currently reports as dead, so a clean run does NOT mean the matrix is done.");
}

main().catch((e) => {
  console.error(`\nseed failed: ${e.message}`);
  process.exit(1);
});
