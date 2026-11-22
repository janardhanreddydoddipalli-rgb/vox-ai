// Mockable auth identity shared by test files: vi.mock("@/lib/auth", ...) with
// makeAuthMock(), then switch identities per test with testAuth. session.user.id
// is the users.id from services/api, as lib/auth.ts sets it.

export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";

const state = { user: { email: "user-a@example.com", id: USER_A } as { email: string; id: string } | null };

function session() {
  return state.user ? { user: { ...state.user, name: "Test User" } } : null;
}

export function makeAuthMock() {
  return {
    auth: () => Promise.resolve(session()),
    currentUserId: () => Promise.resolve(state.user?.id ?? null),
    signIn: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    handlers: {},
    authConfig: {},
  };
}

export const testAuth = {
  asA: () => (state.user = { email: "user-a@example.com", id: USER_A }),
  asB: () => (state.user = { email: "user-b@example.com", id: USER_B }),
  signOut: () => (state.user = null),
};
