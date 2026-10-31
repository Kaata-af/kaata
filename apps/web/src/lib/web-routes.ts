export const WEB_ROUTES = {
  workspace: "/app",
  subscription: "/app/subscription",
  signin: "/app/sign-in",
} as const;

export function isWebAuthPath(pathname: string): boolean {
  return pathname.replace(/\/$/, "") === WEB_ROUTES.signin;
}

export function isRetiredWebAuthPath(pathname: string): boolean {
  const path = pathname.replace(/\/$/, "");
  return path === "/app/sign-up" || path === "/app/forgot-password";
}

export const WEB_AUTH_ROUTE_EVENT = "kaata:web-auth-route-left";
