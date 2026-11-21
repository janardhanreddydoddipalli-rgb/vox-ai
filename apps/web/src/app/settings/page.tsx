import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { upsertUserByEmail } from "@/lib/db";
import { listMyMemories } from "@/lib/memories";
import Link from "next/link";
import SettingsClient from "./settings-client";

// Server component: the signed-in user's own memories, never anyone else's.
export default async function Settings() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/");

  const user = await upsertUserByEmail(email);
  const memories = user ? await listMyMemories(user.id) : [];

  return (
    <main className="page">
      <header className="page-head">
        <Link href="/dashboard" className="back-link">
          ← Dashboard
        </Link>
        <h1>Memory settings</h1>
        <p className="muted">
          Vox remembers your strengths, weaknesses and preferences after each interview and uses them to pick
          questions. Delete anything you don&apos;t want remembered — deleted memories are never recalled.
        </p>
      </header>
      <SettingsClient initialMemories={memories} />
    </main>
  );
}
