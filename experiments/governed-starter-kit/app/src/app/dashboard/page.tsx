import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import RequestsClient, { type PurchaseRequest } from "./requests-client";

// Everything here is read through the signed-in user's session, so RLS decides
// what comes back: own department only, and the profile's role is whatever the
// platform team set in app_metadata.
export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, display_name, departments(name)")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");

  const { data: requests } = await supabase
    .from("purchase_requests")
    .select("id, requester_id, item, vendor, amount, justification, status, decision_note, created_at")
    .order("created_at", { ascending: false });

  const department = (profile.departments as unknown as { name: string } | null)?.name ?? "";

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Purchase requests</h1>
            <p className="text-sm text-muted-foreground">
              {department} - {profile.role}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">{user.email}</p>
            <Link href="/assistant" className="text-sm underline">
              Assistant
            </Link>
          </div>
        </div>
        <RequestsClient
          initial={(requests ?? []) as PurchaseRequest[]}
          userId={user.id}
          isManager={profile.role === "manager"}
        />
      </div>
    </div>
  );
}
