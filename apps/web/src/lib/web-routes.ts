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

// Opening or closing billing changes the URL while the same ledger stays
// mounted. It owns document scroll; the subscription owns its dialog scroll.
export function preservesWorkspaceScroll(from: string | undefined, to: string): boolean {
  const isWorkspacePage = (path: string | undefined) => {
    const normalized = path?.replace(/\/$/, "");
    return normalized === WEB_ROUTES.workspace || normalized === WEB_ROUTES.subscription;
  };
  return isWorkspacePage(from) && isWorkspacePage(to);
}

export const WEB_AUTH_ROUTE_EVENT = "kaata:web-auth-route-left";
