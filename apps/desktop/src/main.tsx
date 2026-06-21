import React from "react";
import ReactDOM from "react-dom/client";
import { App, PlatformContext } from "@aurevoy/web-ui";
import { tauriPlatformAdapter } from "./platform/tauriPlatformAdapter";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PlatformContext.Provider value={tauriPlatformAdapter}>
      <App />
    </PlatformContext.Provider>
  </React.StrictMode>,
);
