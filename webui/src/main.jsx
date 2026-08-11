import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary.jsx";
import { ProgressFeedbackProvider } from "./components/ProgressFeedback.jsx";
import { LanguageProvider } from "./i18n.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LanguageProvider>
      <ProgressFeedbackProvider>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </ProgressFeedbackProvider>
    </LanguageProvider>
  </React.StrictMode>,
);
