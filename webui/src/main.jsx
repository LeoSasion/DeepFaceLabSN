import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary.jsx";
import { LanguageProvider } from "./i18n.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LanguageProvider>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </LanguageProvider>
  </React.StrictMode>,
);
