/**
 * NeuroClaw's own server, on the phone.
 *
 * This is not a smaller copy of the computer's server: it is the same one. interface/main.ts builds the same engine
 * (the language model, the Zip Loop pipeline, every plugin) and interface/web-server.ts serves the same pages and
 * the same /api routes. Only Node itself is replaced, by this project's own shims (./shims): files are the app's
 * private storage, `http` hands requests from the app's local address to the server's own request handler, and
 * what a phone cannot do (start programs, sandbox code) says so.
 *
 * The app calls, through the WebView:
 *   NeuroClawServer.start()                                 -> a promise, resolved when the server is up
 *   NeuroClawServer.request(id, method, url, headersJson, bodyBase64)
 * and receives each answer through NativeHost.call('http.head' | 'http.chunk' | 'http.end', {id, ...}).
 */
import './shims/globals';
import { Buffer } from './shims/buffer';
import { hostCall } from './shims/host';
import { dispatch } from './shims/http';
import { startWeb } from '../../../interface/main';

let ready: Promise<void> | null = null;

function start(): Promise<void> {
  if (!ready) {
    ready = startWeb(7861).then(() => {
      hostCall('log', { level: 'info', message: 'NeuroClaw server is up on the phone' });
      hostCall('ready');
    });
    ready.catch((e) => {
      const why = e && e.stack ? e.stack : String(e);
      hostCall('log', { level: 'error', message: `NeuroClaw server failed to start: ${why}` });
      hostCall('failed', { error: e && e.message ? e.message : String(e) });
    });
  }
  return ready;
}

function request(id: number, method: string, url: string, headersJson: string, bodyBase64: string): void {
  const fail = (e: unknown) => {
    hostCall('http.head', { id, status: 500, message: 'Internal Server Error', headers: { 'content-type': 'text/plain; charset=utf-8' } });
    hostCall('http.chunk', { id, data: Buffer.from(`The phone's server failed: ${e instanceof Error ? e.message : String(e)}`).toString('base64') });
    hostCall('http.end', { id });
  };
  start().then(() => {
    try {
      dispatch(
        { method, url, headers: JSON.parse(headersJson || '{}'), body: bodyBase64 ? Buffer.from(bodyBase64, 'base64') : new Uint8Array(0) },
        {
          head: (status, message, headers) => hostCall('http.head', { id, status, message, headers }),
          chunk: (b) => hostCall('http.chunk', { id, data: Buffer.from(b).toString('base64') }),
          end: () => hostCall('http.end', { id }),
        },
      );
    } catch (e) { fail(e); }
  }, fail);
}

(globalThis as any).NeuroClawServer = { start, request };
