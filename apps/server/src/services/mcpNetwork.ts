import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import type { FetchLike } from "@modelcontextprotocol/client";

export class McpNetworkError extends Error {
  readonly status = 400;
  readonly details = undefined;
}

export const validateMcpUrl = (value: string, allowPrivateNetwork: boolean) => {
  let url: URL;
  try { url = new URL(value); } catch { throw new McpNetworkError("Invalid MCP URL"); }
  if (!url.hostname || url.username || url.password || url.hash || url.search || !["http:", "https:"].includes(url.protocol)) {
    throw new McpNetworkError("Invalid MCP URL");
  }
  if (url.protocol !== "https:" && !allowPrivateNetwork) throw new McpNetworkError("Public MCP endpoints require HTTPS");
  return url;
};

export const validateMcpAddress = (address: string, allowPrivateNetwork: boolean, protocol: string) => {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try { parsed = ipaddr.process(address); } catch { throw new McpNetworkError("Invalid MCP address"); }
  const range = parsed.range();
  if (range === "unicast") {
    if (protocol !== "https:") throw new McpNetworkError("Public MCP endpoints require HTTPS");
    return;
  }
  if (allowPrivateNetwork && ["private", "uniqueLocal", "loopback"].includes(range)) return;
  throw new McpNetworkError("MCP network address is not permitted");
};

export const createMcpFetch = (endpoint: URL, allowPrivateNetwork: boolean): { fetch: FetchLike; close: () => Promise<void> } => {
  const maxResponseBytes = 512 * 1024;
  const agent = new Agent({ connect: {
    lookup(hostname, _options, callback) {
      void (async () => {
        const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
        const addresses = isIP(bareHost) ? [{ address: bareHost, family: isIP(bareHost) }] : await lookup(bareHost, { all: true, verbatim: true });
        if (!addresses.length) throw new McpNetworkError("MCP hostname did not resolve");
        for (const candidate of addresses) validateMcpAddress(candidate.address, allowPrivateNetwork, endpoint.protocol);
        const chosen = addresses[0];
        callback(null, chosen.address, chosen.family);
      })().catch((error: unknown) => callback(error instanceof Error ? error : new McpNetworkError("MCP hostname lookup failed"), "", 0));
    }
  }, maxOrigins: 1 });
  const safeFetch: FetchLike = async (input, init) => {
    const url = validateMcpUrl(String(input instanceof Request ? input.url : input), allowPrivateNetwork);
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) throw new McpNetworkError("MCP request changed endpoint");
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
    const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init, signal, redirect: "manual", dispatcher: agent
    } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new McpNetworkError("MCP redirects are not permitted");
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > maxResponseBytes) {
      await response.body?.cancel();
      throw new McpNetworkError("MCP response exceeds the size limit");
    }
    if (!response.body) return response;
    let totalBytes = 0;
    const boundedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxResponseBytes) throw new McpNetworkError("MCP response exceeds the size limit");
        controller.enqueue(chunk);
      }
    }));
    return new Response(boundedBody, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch: safeFetch, close: () => agent.close() };
};
