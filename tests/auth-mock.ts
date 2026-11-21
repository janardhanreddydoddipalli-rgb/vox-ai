// Mockable auth identity shared by test files. vi.mock("@/lib/auth", ...)
// must be called with a hoist-safe factory: register the desired identity in
// a hoisted-free way by mutating `currentEmail` BEFORE the route under test
// runs — the factory closes over `state` which lives in THIS module, and
// Vitest evaluates the factory lazily on first import of the mocked module.
// Because the routes call auth() per request (not per import), per-test
// identity switching works through setEmail().

const state = { email: "user-a@example.com" as string | null };

export function makeAuthMock() {
  return {
    auth: () =>
      Promise.resolve(state.email ? { user: { email: state.email, name: "Test User" } } : null),
    signIn: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    handlers: {},
    authConfig: {},
  };
}

export const testAuth = {
  asA: () => (state.email = "user-a@example.com"),
  asB: () => (state.email = "user-b@example.com"),
  signOut: () => (state.email = null),
  get email() {
    return state.email;
  },
};
