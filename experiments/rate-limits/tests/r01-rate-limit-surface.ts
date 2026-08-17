import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const SCOPED_PROJECT = "yanbxwcrnumsefavdoqw";
const MGMT_URL = "https://api.supabase.com/v1";

async function l01Control(ctx: Ctx): Promise<TestResult> {
  try {
    const res = await fetch(`${MGMT_URL}/projects`, {
      headers: { Authorization: `Bearer ${ctx.pat}` },
    });
    const headers = Array.from(res.headers.keys())
      .filter((h) => h.toLowerCase().startsWith("x-ratelimit-"))
      .map((h) => h.toLowerCase());

    return {
      id: "L01-control",
      title: "Control: GET /v1/projects",
      status: res.status === 200 ? "pass" : "fail",
      measurements: {
        status: res.status,
        headers_present: headers.join(","),
      },
    };
  } catch (e) {
    return {
      id: "L01-control",
      title: "Control: GET /v1/projects",
      status: "fail",
      detail: String(e),
    };
  }
}

async function l01a(ctx: Ctx): Promise<TestResult> {
  const results: (number | undefined)[] = [];
  let limit = -1;

  try {
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${MGMT_URL}/projects/${SCOPED_PROJECT}`, {
        headers: { Authorization: `Bearer ${ctx.pat}` },
      });
      if (i === 1) {
        const l = res.headers.get("x-ratelimit-limit");
        limit = l ? parseInt(l, 10) : -1;
      }
      const rem = res.headers.get("x-ratelimit-remaining");
      results.push(rem ? parseInt(rem, 10) : -1);
    }

    return {
      id: "L01a",
      title: "Sequential scoped reads",
      status: "info",
      measurements: {
        remaining_1: results[0] ?? -1,
        remaining_2: results[1] ?? -1,
        remaining_3: results[2] ?? -1,
        limit: limit,
      },
    };
  } catch (e) {
    return {
      id: "L01a",
      title: "Sequential scoped reads",
      status: "fail",
      detail: String(e),
    };
  }
}

async function l01b(ctx: Ctx): Promise<TestResult> {
  const pat2 = process.env.PVLAB_PAT2;
  if (!pat2) {
    return {
      id: "L01b",
      title: "Alternate PATs",
      status: "skip",
      detail: "PVLAB_PAT2 is not set in this loop",
    };
  }

  const pat1 = ctx.pat!;
  const p1_rems: number[] = [];
  const p2_rems: number[] = [];

  try {
    for (let i = 0; i < 4; i++) {
      const res1 = await fetch(`${MGMT_URL}/projects/${SCOPED_PROJECT}`, {
        headers: { Authorization: `Bearer ${pat1}` },
      });
      const rem1 = res1.headers.get("x-ratelimit-remaining");
      p1_rems.push(rem1 ? parseInt(rem1, 10) : -1);

      const res2 = await fetch(`${MGMT_URL}/projects/${SCOPED_PROJECT}`, {
        headers: { Authorization: `Bearer ${pat2}` },
      });
      const rem2 = res2.headers.get("x-ratelimit-remaining");
      p2_rems.push(rem2 ? parseInt(rem2, 10) : -1);
    }

    return {
      id: "L01b",
      title: "Alternate PATs",
      status: "info",
      measurements: {
        pat1_remaining: p1_rems.join(","),
        pat2_remaining: p2_rems.join(","),
      },
    };
  } catch (e) {
    return {
      id: "L01b",
      title: "Alternate PATs",
      status: "fail",
      detail: String(e),
    };
  }
}

async function l01c(ctx: Ctx): Promise<TestResult> {
  let requests_sent = 0;
  let first_non200_status = 0;
  let first_non200_content_type = "none";
  let retry_after = "none";
  let evidence = "";
  let hit_429 = false;

  try {
    for (let i = 0; i < 150; i++) {
      requests_sent++;
      const res = await fetch(`${MGMT_URL}/projects/${SCOPED_PROJECT}`, {
        headers: { Authorization: `Bearer ${ctx.pat}` },
      });

      if (res.status !== 200) {
        first_non200_status = res.status;
        first_non200_content_type = res.headers.get("content-type") || "none";
        retry_after = res.headers.get("retry-after") || "none";
        const body = await res.text();
        evidence = body.slice(0, 300);
        if (res.status === 429) hit_429 = true;
        break;
      }
    }

    let recovered_status: string | undefined;
    if (hit_429) {
      // Wait ~65s and re-probe once
      await new Promise((r) => setTimeout(r, 65000));
      try {
        const res = await fetch(`${MGMT_URL}/projects/${SCOPED_PROJECT}`, {
          headers: { Authorization: `Bearer ${ctx.pat}` },
        });
        recovered_status = String(res.status);
      } catch (e) {
        recovered_status = "error";
      }
    }

    const measurements: Record<string, string | number> = {
      requests_sent,
      first_non200_status,
      first_non200_content_type,
      retry_after,
    };
    if (recovered_status) {
      measurements.recovered_status = recovered_status;
    }

    return {
      id: "L01c",
      title: "Rate limit burst",
      status: "info",
      measurements,
      evidence: evidence,
    };
  } catch (e) {
    return {
      id: "L01c",
      title: "Rate limit burst",
      status: "fail",
      detail: String(e),
    };
  }
}

const mod: TestModule = {
  id: "L01",
  title: "Rate limit surface",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx) {
    // The requirement says "The budget returns after the window". 
    // This is a comment for the destructive flag.
    return [
      await l01Control(ctx),
      await l01a(ctx),
      await l01b(ctx),
      await l01c(ctx),
    ];
  },
};
export default mod;
