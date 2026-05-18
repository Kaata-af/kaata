import { Route, Routes } from "react-router-dom";
import { CustomerView } from "./pages/CustomerView";
import { Download } from "./pages/Download";
import { Home } from "./pages/Home";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/download" element={<Download />} />
      <Route path="/v/:token" element={<CustomerView />} />
    </Routes>
  );
}
