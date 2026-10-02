/**
 * TL18 - remove the IPv4 add-on TL14 put on, so a long gap between passes
 * does not keep billing. DESTRUCTIVE (removes an add-on).
 */
import type { TestModule } from "../../../harness/src/types";
import { addons, removeAddon } from "../../medium-serverless/lib/setup";

const mod: TestModule = {
  id: "TL18",
  title: "IPv4 add-on off (cleanup after TL14)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx) {
    const ad = await addons(ctx);
    const sel = ad.selected.find((a) => a.type === "ipv4");
    if (!sel) return [{ id: "TL18", title: mod.title, status: "info", detail: "ipv4 add-on not selected - nothing to remove" }];
    const r = await removeAddon(ctx, sel.variant || "ipv4_default");
    return [{ id: "TL18", title: mod.title, status: r.status < 300 ? "pass" : "fail", detail: `DELETE ${sel.variant} HTTP ${r.status} ${r.status >= 300 ? r.text : ""}`.trim(), measurements: { remove_http: r.status } }];
  },
};
export default mod;
