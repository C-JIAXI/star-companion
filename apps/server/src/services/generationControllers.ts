export class GenerationControllerRegistry<TSocket extends object> {
  private readonly entries = new Map<
    string,
    { controller: AbortController; socket: TSocket }
  >();

  register(requestId: string, socket: TSocket, controller: AbortController) {
    this.entries.get(requestId)?.controller.abort();
    this.entries.set(requestId, { controller, socket });
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
    let aborted = 0;
    for (const [requestId, entry] of this.entries) {
      if (entry.socket !== socket) continue;
      entry.controller.abort();
      this.entries.delete(requestId);
      aborted += 1;
    }
    return aborted;
  }
}
