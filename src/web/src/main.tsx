import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/onboarding.css";

// The desktop shell announces itself so the layout can make room for the
// window controls; in a browser tab this is simply absent.
if (new URLSearchParams(location.search).get("shell") === "desktop") {
  document.documentElement.setAttribute("data-shell", "desktop");
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
