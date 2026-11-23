// Prints the account id that owns CF_ZONE_NAME (default erfi.dev), so wrangler
// targets the right account when the global key can see several.
const zone = process.env.CF_ZONE_NAME ?? "erfi.dev";
const r = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${zone}`, {
  headers: { "X-Auth-Email": process.env.CLOUDFLARE_EMAIL!, "X-Auth-Key": process.env.CLOUDFLARE_API_KEY! },
});
const j: any = await r.json();
console.log(j.result[0].account.id);
