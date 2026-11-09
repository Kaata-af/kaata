import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { I18nProvider } from "./lib/i18n";
import { Home } from "./pages/Home";
import { Privacy } from "./pages/Privacy";
import { Terms } from "./pages/Terms";

// Anonymous readers can see the public pages before JavaScript loads. The SPA
// still mounts normally to pick up the visitor's language, device and session.
const root = '<div id="root"></div>';
const shell = readFileSync("dist/index.html", "utf8");
if (!shell.includes(root)) throw new Error("The built HTML is missing the Kaata root element");

mkdirSync("dist/_public", { recursive: true });
for (const { location, file, Page, title } of [
  { location: "/", file: "home", Page: Home },
  { location: "/privacy", file: "privacy", Page: Privacy, title: "Kaata Privacy Policy" },
  { location: "/terms", file: "terms", Page: Terms, title: "Kaata Terms of Service" },
]) {
  const content = renderToStaticMarkup(
    <StaticRouter location={location}>
      <I18nProvider>
        <Page />
      </I18nProvider>
    </StaticRouter>,
  );
  const document =
    title
      ? shell
          .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
          .replace(
            'rel="canonical" href="https://kaata.af/"',
            `rel="canonical" href="https://kaata.af${location}"`,
          )
      : shell;
  writeFileSync(
    `dist/_public/${file}.html`,
    document.replace(root, () => `<div id="root">${content}</div>`),
  );
}
