import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { mountGoogleButton } from "./web-google";

type Initialization = {
  client_id: string;
  nonce: string;
  auto_select: boolean;
  callback: (result: { credential?: string }) => void;
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
const configurations: Initialization[] = [];
type ButtonOptions = {
  locale: string;
  width: number;
  shape: string;
  theme: string;
  size: string;
  logo_alignment: string;
};
const renders: { element: HTMLElement; options: ButtonOptions }[] = [];
const scripts: HTMLScriptElement[] = [];
const controllers: AbortController[] = [];
const observers: SizeObserver[] = [];
class SizeObserver {
  disconnected = false;
  constructor(private callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  notify() {
    this.callback([], this as unknown as ResizeObserver);
  }
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: SizeObserver });
const identity = {
  initialize: (options: Initialization) => {
    configurations.push(options);
  },
  renderButton: (element: HTMLElement, options: ButtonOptions) => {
    renders.push({ element, options });
  },
  disableAutoSelect: () => {},
};
const browser: { google?: { accounts: { id: typeof identity } } } = {};
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement: (tag: string) => {
      assert.equal(tag, "script");
      return { remove: () => {} };
    },
    head: {
      appendChild: (script: HTMLScriptElement) => {
        scripts.push(script);
      },
    },
  },
});
function element(width = 300) {
  let clears = 0;
  const node = {
    clientWidth: width,
    replaceChildren: () => {
      clears++;
    },
  };
  return {
    node: node as unknown as HTMLElement,
    setWidth: (value: number) => {
      node.clientWidth = value;
    },
    clears: () => clears,
  };
}
function controller() {
  const value = new AbortController();
  controllers.push(value);
  return value;
}
beforeEach(() => {
  configurations.length = 0;
  renders.length = 0;
  observers.length = 0;
});
afterEach(() => {
  controllers.splice(0).forEach((value) => value.abort());
});
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
  if (originalResizeObserver)
    Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

test("Google does not load an SDK for an already-cancelled mount", async () => {
  const signal = controller();
  signal.abort();
  await mountGoogleButton(
    element().node,
    "en",
    "first.apps.googleusercontent.com",
    () => assert.fail(),
    signal.signal,
  );
  assert.equal(scripts.length, 0);
});

test("Google loads the initial button language and allows another load after a script failure", async () => {
  const aborted = controller();
  const pending = mountGoogleButton(
    element().node,
    "en",
    "first.apps.googleusercontent.com",
    () => assert.fail(),
    aborted.signal,
  );
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, "https://accounts.google.com/gsi/client?hl=en");
  assert.equal(scripts[0].referrerPolicy, "strict-origin");
  aborted.abort();
  scripts[0].onerror?.(new Event("error"));
  await pending;
  assert.equal(configurations.length, 0);
  const failed = mountGoogleButton(
    element().node,
    "fa",
    "first.apps.googleusercontent.com",
    () => assert.fail(),
    controller().signal,
  );
  assert.equal(scripts[1].src, "https://accounts.google.com/gsi/client?hl=fa");
  scripts[1].onerror?.(new Event("error"));
  await assert.rejects(failed, /could not load/);
  const retry = mountGoogleButton(
    element().node,
    "ps",
    "runtime.apps.googleusercontent.com",
    () => {},
    controller().signal,
  );
  assert.equal(scripts[2].src, "https://accounts.google.com/gsi/client?hl=en");
  browser.google = { accounts: { id: identity } };
  scripts[2].onload?.call(scripts[2], new Event("load"));
  await retry;
  assert.equal(configurations[0].client_id, "runtime.apps.googleusercontent.com");
});

test("Google uses runtime configuration and a fresh cryptographic nonce for every mount", async () => {
  const loadedScriptCount = scripts.length;
  const first = controller();
  await mountGoogleButton(
    element(900).node,
    "fa",
    "first.apps.googleusercontent.com",
    () => {},
    first.signal,
  );
  first.abort();
  await mountGoogleButton(
    element(50).node,
    "ps",
    "second.apps.googleusercontent.com",
    () => {},
    controller().signal,
  );
  assert.equal(configurations[0].client_id, "first.apps.googleusercontent.com");
  assert.equal(configurations[1].client_id, "second.apps.googleusercontent.com");
  assert.match(configurations[0].nonce, /^[a-f0-9]{64}$/);
  assert.notEqual(configurations[0].nonce, configurations[1].nonce);
  assert.equal(configurations[0].auto_select, false);
  assert.equal(renders[0].options.locale, "fa");
  assert.equal(renders[0].options.width, 400);
  assert.equal(renders[0].options.shape, "pill");
  assert.equal(renders[0].options.theme, "outline");
  assert.equal(renders[0].options.size, "large");
  assert.equal(renders[0].options.logo_alignment, "left");
  assert.equal(renders[1].options.locale, "en");
  assert.equal(renders[1].options.width, 200);
  assert.equal(scripts.length, loadedScriptCount, "language changes reuse the loaded SDK");
});

test("Google forwards one credential with that mount's nonce and ignores malformed or repeated callbacks", async () => {
  const received: string[][] = [];
  await mountGoogleButton(
    element().node,
    "en",
    "first.apps.googleusercontent.com",
    (...values) => {
      received.push(values);
    },
    controller().signal,
  );
  const config = configurations[0];
  config.callback({});
  config.callback({ credential: "" });
  config.callback({ credential: "x".repeat(20_001) });
  assert.equal(received.length, 0);
  config.callback({ credential: "provider-credential" });
  config.callback({ credential: "replayed-credential" });
  assert.deepEqual(received, [["provider-credential", config.nonce]]);
});

test("an older Google mount cannot deliver credentials or clear the newer button", async () => {
  const button = element();
  const old = controller();
  const received: string[][] = [];
  await mountGoogleButton(
    button.node,
    "en",
    "first.apps.googleusercontent.com",
    () => assert.fail("stale callback"),
    old.signal,
  );
  const previous = configurations[0];
  await mountGoogleButton(
    button.node,
    "en",
    "second.apps.googleusercontent.com",
    (...values) => {
      received.push(values);
    },
    controller().signal,
  );
  const clearsBeforeOldAbort = button.clears();
  old.abort();
  assert.equal(button.clears(), clearsBeforeOldAbort);
  previous.callback({ credential: "stale-credential" });
  configurations[1].callback({ credential: "current-credential" });
  assert.deepEqual(received, [["current-credential", configurations[1].nonce]]);
});

test("Google ignores a credential arriving after cancellation", async () => {
  const current = controller();
  const button = element();
  await mountGoogleButton(
    button.node,
    "en",
    "first.apps.googleusercontent.com",
    () => assert.fail("cancelled callback"),
    current.signal,
  );
  current.abort();
  configurations[0].callback({ credential: "late-credential" });
  assert.equal(button.clears(), 2);
});

test("Google responds to card width changes without replacing the nonce or credential callback", async () => {
  const button = element(340);
  const received: string[][] = [];
  await mountGoogleButton(
    button.node,
    "en",
    "first.apps.googleusercontent.com",
    (...values) => {
      received.push(values);
    },
    controller().signal,
  );
  const config = configurations[0];
  observers[0].notify();
  button.setWidth(300);
  observers[0].notify();
  button.setWidth(280);
  observers[0].notify();
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.deepEqual(
    renders.map((render) => render.options.width),
    [340, 280],
  );
  assert.equal(configurations.length, 1);
  assert.equal(configurations[0], config);
  config.callback({ credential: "resized-credential" });
  assert.deepEqual(received, [["resized-credential", config.nonce]]);
});

test("cancelled or superseded Google size observers cannot redraw another login attempt", async () => {
  const button = element(320);
  const first = controller();
  await mountGoogleButton(
    button.node,
    "en",
    "first.apps.googleusercontent.com",
    () => {},
    first.signal,
  );
  const staleObserver = observers[0];
  button.setWidth(250);
  staleObserver.notify();
  await mountGoogleButton(
    button.node,
    "fa",
    "second.apps.googleusercontent.com",
    () => {},
    controller().signal,
  );
  const clearsBeforeOldAbort = button.clears();
  first.abort();
  assert.equal(staleObserver.disconnected, true);
  assert.equal(button.clears(), clearsBeforeOldAbort);
  button.setWidth(400);
  staleObserver.notify();
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.deepEqual(
    renders.map((render) => render.options.width),
    [320, 250],
  );
  assert.equal(configurations.length, 2);
});

test("Google rejects invalid runtime client IDs before rendering a button", async () => {
  await assert.rejects(() =>
    mountGoogleButton(
      element().node,
      "en",
      "not a client ID",
      () => assert.fail(),
      controller().signal,
    ),
  );
  assert.equal(configurations.length, 0);
  assert.equal(renders.length, 0);
});
