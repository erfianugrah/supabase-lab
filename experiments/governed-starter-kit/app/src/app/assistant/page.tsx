import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import AssistantClient from "./assistant-client";

// The page only checks there is a session. The agent function runs every tool
// as this user, so what the assistant can see or change is exactly what the
// dashboard can.
export default async function AssistantPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold">Assistant</h1>
            <p className="text-sm text-muted-foreground">
              Acts as {user.email}. Submitting or deciding a request asks you to confirm first.
            </p>
          </div>
          <Link href="/dashboard" className="text-sm underline">
            Dashboard
          </Link>
        </div>
        <AssistantClient />
      </div>
    </div>
  );
}
