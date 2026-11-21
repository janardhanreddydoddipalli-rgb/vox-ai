import { auth, signIn } from "@/lib/auth";
import { redirect } from "next/navigation";

// Sign-in options: Google OAuth and email magic link (Resend). A provider
// renders only when its env vars are configured.
export default async function SignIn({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl = "/dashboard" } = await searchParams;
  const session = await auth();
  if (session?.user) redirect(callbackUrl);

  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const emailEnabled = Boolean(process.env.RESEND_API_KEY);

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
      {emailEnabled && (
        <form
          action={async (fd: FormData) => {
            "use server";
            await signIn("resend", { email: fd.get("email"), redirectTo: callbackUrl });
          }}
        >
          <input name="email" type="email" required placeholder="you@example.com" aria-label="Email" />
          <button className="btn" type="submit">
            Email me a magic link
          </button>
        </form>
      )}
      {!googleEnabled && !emailEnabled && (
        <p className="error">
          No sign-in provider is configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (OAuth) or
          RESEND_API_KEY (magic link) in the environment.
        </p>
      )}
    </main>
  );
}
