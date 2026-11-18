import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Briefing } from "./briefing/Briefing.js";
import { AskApp } from "./ask/AskApp.js";
import { followAskAppearance } from "./ask/appearance.js";
import { installDiagnosticCapture } from "./diagnostics.js";
import "./app.css";

installDiagnosticCapture();
const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");
const view = new URLSearchParams(location.search).get("view");
if (view === "ask") followAskAppearance();
createRoot(container).render(
  <React.StrictMode>
    {view === "briefing" ? <Briefing floating /> : view === "ask" ? <AskApp /> : <App />}
  </React.StrictMode>,
);
