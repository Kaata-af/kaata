import { createWebAuthNonce } from "./web-auth";

type GoogleIdentity = {
  initialize: (options: {
    client_id: string;
    callback: (result: { credential?: string }) => void;
    auto_select: boolean;
    nonce: string;
  }) => void;
  renderButton: (
    element: HTMLElement,
    options: {
      theme: string;
      size: string;
      text: string;
      shape: string;
      logo_alignment: string;
      width: number;
      locale: string;
    },
  ) => void;
  disableAutoSelect: () => void;
};

let ready: Promise<GoogleIdentity> | undefined;
let activeMount: object | undefined;

function googleIdentity(): GoogleIdentity | undefined {
  return (window as Window & { google?: { accounts?: { id?: GoogleIdentity } } }).google?.accounts
    ?.id;
}

function loadGoogle(locale: string): Promise<GoogleIdentity> {
  const existing = googleIdentity();
  if (existing) return Promise.resolve(existing);
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
      resolve(identity);
    };
    const timeout = setTimeout(complete, 15_000);
    // Both the SDK and each rendered button receive a supported language.
    // Pashto uses Google's English fallback; the surrounding page stays Pashto.
    script.src = `https://accounts.google.com/gsi/client?hl=${locale}`;
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
  clientID: string,
  callback: (credential: string, nonce: string) => void,
  signal: AbortSignal,
) {
  if (signal.aborted) return;
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientID) || clientID.length > 255) {
    throw new Error("Google sign-in is unavailable");
  }
  const mount = {};
  const nonce = createWebAuthNonce();
  const locale = lang === "fa" ? "fa" : "en";
  let delivered = false;
  let observer: ResizeObserver | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  activeMount = mount;
  const cleanup = () => {
    observer?.disconnect();
    clearTimeout(resizeTimer);
    if (activeMount !== mount) return;
    activeMount = undefined;
    element.replaceChildren();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  let identity: GoogleIdentity;
  try {
    identity = await loadGoogle(locale);
  } catch (error) {
    cleanup();
    signal.removeEventListener("abort", cleanup);
    if (!signal.aborted) throw error;
    return;
  }
  if (signal.aborted || activeMount !== mount) return;
  // GIS retains the latest initialize options. A new mount is a new login
  // attempt, with its own nonce and callback guard, including after a failure.
  identity.initialize({
    client_id: clientID,
    auto_select: false,
    nonce,
    callback: (result) => {
      if (
        signal.aborted ||
        activeMount !== mount ||
        delivered ||
        typeof result?.credential !== "string" ||
        !result.credential ||
        result.credential.length > 20_000
      )
        return;
      delivered = true;
      callback(result.credential, nonce);
    },
  });
  const buttonWidth = () => Math.min(400, Math.max(200, Math.floor(element.clientWidth)));
  let renderedWidth: number | undefined;
  const render = () => {
    if (signal.aborted || activeMount !== mount) return;
    const width = buttonWidth();
    if (width === renderedWidth) return;
    renderedWidth = width;
    element.replaceChildren();
    identity.renderButton(element, {
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      logo_alignment: "left",
      width,
      locale,
    });
  };
  render();
  // Resizing changes only Google's presentation. Retain the same verified
  // login attempt, nonce and guarded callback while the card changes width.
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      if (signal.aborted || activeMount !== mount || buttonWidth() === renderedWidth) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 100);
    });
    observer.observe(element);
  }
}
