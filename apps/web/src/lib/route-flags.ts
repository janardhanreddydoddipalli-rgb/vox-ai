// Strangler migration (M3): each route is served by apps/web ("next", default)
// or forwarded to services/api ("fastapi"). Flipping the env var back is the rollback.
export type RouteName = "MEMORIES" | "TURNS" | "INTERVIEWS" | "CHAT" | "AGENT" | "VOICE" | "RAG";
export type RouteTarget = "next" | "fastapi";

export function routeTarget(name: RouteName): RouteTarget {
  return process.env[`ROUTE_${name}`] === "fastapi" ? "fastapi" : "next";
}
