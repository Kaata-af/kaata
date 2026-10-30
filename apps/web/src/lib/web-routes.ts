export const WEB_ROUTES = {
  workspace: "/app",
  signin: "/app/sign-in",
  signup: "/app/sign-up",
  reset: "/app/forgot-password",
} as const;

export type WebAuthMode = "signin" | "signup" | "reset";

export function authRoute(mode: WebAuthMode): string {
  return WEB_ROUTES[mode];
}

export function webAuthMode(pathname: string): WebAuthMode | null {
  const path = pathname.replace(/\/$/, "");
  for (const mode of ["signin", "signup", "reset"] as const) {
    if (path === WEB_ROUTES[mode]) return mode;
  }
  return null;
}

export const WEB_AUTH_ROUTE_EVENT = "kaata:web-auth-route-left";
