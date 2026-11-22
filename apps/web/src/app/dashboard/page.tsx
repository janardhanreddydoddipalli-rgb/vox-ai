import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { loadDashboard } from "@/lib/interviews";
import DashboardClient from "./dashboard-client";

// Server component: the signed-in user's own history only (from services/api).
export default async function Dashboard() {
  const session = await auth();
  const email = session?.user?.email;
  const userId = session?.user?.id;
  if (!email || !userId) redirect("/");

  const data = await loadDashboard(userId);

  return (
    <main>
      <DashboardClient email={email} {...data} />
    </main>
  );
}
