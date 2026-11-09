import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { I18nProvider } from "./lib/i18n";
import { Home } from "./pages/Home";
import { Privacy } from "./pages/Privacy";

// Anonymous readers can see the public pages before JavaScript loads. The SPA
// still mounts normally to pick up the visitor's language, device and session.
const root = '<div id="root"></div>';
const shell = readFileSync("dist/index.html", "utf8");
if (!shell.includes(root)) throw new Error("The built HTML is missing the Kaata root element");

mkdirSync("dist/_public", { recursive: true });
for (const { location, file, Page } of [
  { location: "/", file: "home", Page: Home },
  { location: "/privacy", file: "privacy", Page: Privacy },
]) {
  const content = renderToStaticMarkup(
    <StaticRouter location={location}>
      <I18nProvider>
        <Page />
      </I18nProvider>
    </StaticRouter>,
  );
  const document =
    location === "/privacy"
      ? shell
          .replace(/<title>.*?<\/title>/, "<title>Kaata Privacy Policy</title>")
          .replace(
            'rel="canonical" href="https://kaata.af/"',
            'rel="canonical" href="https://kaata.af/privacy"',
          )
      : shell;
  writeFileSync(
    `dist/_public/${file}.html`,
    document.replace(root, () => `<div id="root">${content}</div>`),
  );
}
