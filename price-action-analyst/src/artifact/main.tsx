import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/app.css";
import "./instant.css";
import { InstantApp } from "./InstantApp.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <InstantApp />
  </StrictMode>,
);
