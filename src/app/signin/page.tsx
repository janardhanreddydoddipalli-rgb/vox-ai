import { auth, signIn } from "@/lib/auth";
import { redirect } from "next/navigation";

// Sign-in: Google OAuth only (docs/adr/0002-google-only-auth.md). The button
// renders only when its env vars are configured.
export default async function SignIn({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl = "/dashboard" } = await searchParams;
  const session = await auth();
  if (session?.user) redirect(callbackUrl);

  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const e2eButton = process.env.E2E_TEST_AUTH === "1";

  return (
    <main style={{ maxWidth: 420, margin: "80px auto", padding: 24, textAlign: "center" }}>
      <h1>Sign in to Vox</h1>
      <p className="muted">Your conversation history is tied to your account.</p>
      {googleEnabled && (
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: callbackUrl });
          }}
        >
          <button className="btn primary" type="submit">
            Continue with Google
          </button>
        </form>
      )}
      {!googleEnabled && !e2eButton && (
        <p className="error">
          No sign-in provider is configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the environment.
        </p>
      )}
      {e2eButton && (
        <form
          action={async (fd: FormData) => {
            "use server";
            await signIn("credentials", { email: fd.get("email"), redirectTo: callbackUrl });
          }}
        >
          <input name="email" type="email" required placeholder="you@example.com" aria-label="Email" />
          <button className="btn" type="submit">
            Test sign-in
          </button>
        </form>
      )}
    </main>
  );
}
