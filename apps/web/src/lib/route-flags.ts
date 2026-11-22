// Strangler migration: each route is forwarded to services/api ("fastapi",
// the default since M4) or served by apps/web ("next"). ROUTE_<NAME>=next is
// the rollback until the web's own implementations are removed.
export type RouteName = "MEMORIES" | "TURNS" | "INTERVIEWS" | "CHAT" | "AGENT" | "VOICE";
export type RouteTarget = "next" | "fastapi";

export function routeTarget(name: RouteName): RouteTarget {
  return process.env[`ROUTE_${name}`] === "next" ? "next" : "fastapi";
}
