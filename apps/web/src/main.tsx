import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Chromium can switch a pointer-focused control to :focus-visible after an unrelated key press.
// Keep that control pointer-focused until it loses focus; a later Tab focus still gets a ring.
document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>("button, [role='button'], a[href], input, textarea, select, summary, [tabindex]");
  if (!control) return;
  control.setAttribute("data-pointer-focus", "");
  window.setTimeout(() => {
    if (document.activeElement !== control) control.removeAttribute("data-pointer-focus");
  }, 0);
}, true);

document.addEventListener("focusout", (event) => {
  if (event.target instanceof HTMLElement) event.target.removeAttribute("data-pointer-focus");
}, true);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
