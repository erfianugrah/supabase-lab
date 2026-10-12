/**
 * tus-js-client HttpStack on fetch, with a per-request timeout.
 *
 * Why: the library's Node stack (node:http) misbehaved under Bun twice in
 * this experiment: the Buffer body path stalled until the server's 408
 * "stream timeout", and the Readable path later hung one PATCH against a
 * managed project with the connection open and no bytes moving, for 18 min,
 * with no timeout to turn the hang into a retry. On fetch, a stalled request
 * is aborted after `timeoutMs`, tus-js-client sees an error, retries per
 * `retryDelays`, and resumes from the server's offset (HEAD). The same stack
 * runs in the browser.
 */
import type { HttpRequest, HttpResponse, HttpStack } from "tus-js-client";

class FetchResponse implements HttpResponse {
  constructor(
    private res: Response,
    private body: string,
  ) {}
  getStatus() {
    return this.res.status;
  }
  getHeader(h: string) {
    return this.res.headers.get(h) ?? undefined;
  }
  getBody() {
    return this.body;
  }
  getUnderlyingObject() {
    return this.res;
  }
}

class FetchRequest implements HttpRequest {
  private headers: Record<string, string> = {};
  private ctl = new AbortController();
  private progress: (n: number) => void = () => {};
  constructor(
    private method: string,
    private url: string,
    private timeoutMs: number,
  ) {}
  getMethod() {
    return this.method;
  }
  getURL() {
    return this.url;
  }
  setHeader(h: string, v: string) {
    this.headers[h] = v;
  }
  getHeader(h: string) {
    return this.headers[h];
  }
  setProgressHandler(f: (n: number) => void) {
    this.progress = f;
  }
  async send(body: unknown = null): Promise<HttpResponse> {
    const timer = setTimeout(() => this.ctl.abort(new Error(`tus ${this.method} timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
    try {
      const res = await fetch(this.url, { method: this.method, headers: this.headers, body: (body ?? undefined) as BodyInit | undefined, signal: this.ctl.signal });
      const text = await res.text();
      if (body instanceof Blob) this.progress(body.size);
      return new FetchResponse(res, text);
    } finally {
      clearTimeout(timer);
    }
  }
  async abort() {
    this.ctl.abort();
  }
  getUnderlyingObject() {
    return this.ctl;
  }
}

export class FetchHttpStack implements HttpStack {
  constructor(private timeoutMs = 120_000) {}
  createRequest(method: string, url: string): HttpRequest {
    return new FetchRequest(method, url, this.timeoutMs);
  }
  getName() {
    return "FetchHttpStack";
  }
}
