export class GenerationControllerRegistry<TSocket extends object> {
  private readonly entries = new Map<
    string,
    { controller: AbortController; socket: TSocket }
  >();

  register(requestId: string, socket: TSocket, controller: AbortController) {
    if (this.entries.has(requestId)) return false;
    this.entries.set(requestId, { controller, socket });
    return true;
  }

  release(requestId: string, controller?: AbortController) {
    const entry = this.entries.get(requestId);
    if (!entry || (controller && entry.controller !== controller)) return false;
    this.entries.delete(requestId);
    return true;
  }

  abortRequest(requestId: string) {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  abortSocket(socket: TSocket) {
    // A browser refresh or temporary WebSocket loss must not resubmit or cancel a paid call.
    // The request remains addressable by requestId and may be explicitly stopped after reconnect.
    return [...this.entries.values()].filter((entry) => entry.socket === socket).length;
  }
}
