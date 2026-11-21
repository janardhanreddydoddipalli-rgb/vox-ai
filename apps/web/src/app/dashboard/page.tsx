import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { upsertUserByEmail } from "@/lib/db";
import { loadDashboard } from "@/lib/interviews";
import DashboardClient from "./dashboard-client";

// Server component: load the signed-in user's own history only (from apps/web's
// DB or services/api, per ROUTE_TURNS / ROUTE_INTERVIEWS).
export default async function Dashboard() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/");

  const user = await upsertUserByEmail(email);
  const data = user ? await loadDashboard(user.id) : { sessions: [], turns: [], interviews: [], qaScores: [] };

  return (
    <main>
      <DashboardClient email={email} {...data} />
    </main>
  );
}
