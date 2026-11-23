const boot = crypto.randomUUID();
Deno.serve(async () => {
  const r = await fetch("https://api.ipify.org?format=json");
  const { ip } = await r.json();
  return Response.json({ ip, boot, region: Deno.env.get("SB_REGION") ?? null, exec: Deno.env.get("SB_EXECUTION_ID") ?? null });
});
