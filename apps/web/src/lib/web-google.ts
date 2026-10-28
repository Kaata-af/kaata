import { GOOGLE_WEB_CLIENT_ID } from "../env";

type GoogleIdentity = {
  initialize: (options: {
    client_id: string;
    callback: (result: { credential?: string }) => void;
    auto_select: boolean;
  }) => void;
  renderButton: (
    element: HTMLElement,
    options: { theme: string; size: string; text: string; width: number; locale: string },
  ) => void;
  disableAutoSelect: () => void;
};

let ready: Promise<GoogleIdentity> | undefined;
let receiveCredential: ((credential: string) => void) | undefined;

function googleIdentity(): GoogleIdentity | undefined {
  return (window as Window & { google?: { accounts?: { id?: GoogleIdentity } } }).google?.accounts
    ?.id;
}

function loadGoogle(): Promise<GoogleIdentity> {
  if (ready) return ready;
  ready = new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script");
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      const identity = googleIdentity();
      if (!identity) {
        script.remove();
        reject(new Error("Google sign-in could not load"));
        return;
      }
      identity.initialize({
        client_id: GOOGLE_WEB_CLIENT_ID,
        auto_select: false,
        callback: (result) => {
          if (result.credential) receiveCredential?.(result.credential);
        },
      });
      resolve(identity);
    };
    const timeout = setTimeout(complete, 15_000);
    script.src = "https://accounts.google.com/gsi/client";
    // GIS can validate the site's origin without receiving an app path/query.
    script.referrerPolicy = "strict-origin";
    script.async = true;
    script.onload = complete;
    script.onerror = complete;
    document.head.appendChild(script);
  }).catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

// GIS owns the button and account chooser; credentials go straight to Kaata's
// existing token-verifying endpoint and are never persisted by this module.
export async function mountGoogleButton(
  element: HTMLElement,
  lang: string,
  callback: (credential: string) => void,
  signal: AbortSignal,
) {
  const identity = await loadGoogle();
  if (signal.aborted) return;
  receiveCredential = callback;
  identity.renderButton(element, {
    theme: "outline",
    size: "large",
    text: "continue_with",
    width: Math.min(360, Math.max(200, element.clientWidth)),
    locale: lang === "ps" ? "en" : lang,
  });
  signal.addEventListener(
    "abort",
    () => {
      if (receiveCredential === callback) receiveCredential = undefined;
      element.replaceChildren();
    },
    { once: true },
  );
}
