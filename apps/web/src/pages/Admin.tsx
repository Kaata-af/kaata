// Thin re-export — the dashboard lives in ./admin/ (AdminApp + sections).
// This file stays as the lazy code-split entry App.tsx imports, so the
// recharts/react-query chunk still never ships in the public marketing
// bundle. Both exports are load-bearing: `default` feeds React.lazy, and the
// named `Admin` preserves the old import surface.
export { AdminApp as Admin, default } from "./admin/AdminApp";
