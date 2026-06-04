const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const getBackendBaseUrl = () => {
  const configured = import.meta.env.VITE_API_BASE_URL;

  if (typeof configured === "string" && configured.trim()) {
    return trimTrailingSlash(configured.trim());
  }

  return "";
};

export const resolveApiUrl = (path: string) => {
  const baseUrl = getBackendBaseUrl();
  return baseUrl ? `${baseUrl}${path}` : path;
};

export const resolveWebSocketUrl = () => {
  const baseUrl = getBackendBaseUrl();

  if (baseUrl) {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = import.meta.env.DEV ? `${window.location.hostname}:4000` : window.location.host;

  return `${protocol}//${host}/ws`;
};
