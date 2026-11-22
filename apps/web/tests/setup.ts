// Test setup. The web app has no database or model access since M4: every test
// here is a unit test, and services/api is never running (calls to it are mocked).
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-not-a-real-credential";

if (process.env.NODE_ENV !== "test") {
  throw new Error("Tests must run with NODE_ENV=test");
}
