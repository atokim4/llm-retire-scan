import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * A local stand-in for wss://api.openai.com/v1/realtime, shaped from the Realtime conversations guide and the
 * openai SDK's server event types. `script` decides what the server does once the client sends response.create.
 */
export type Script = (socket: WebSocket, received: unknown[]) => void;

export interface FakeServer {
  url: string;
  /** Every client event, parsed, in arrival order. */
  received: unknown[];
  requests: IncomingMessage[];
  close(): Promise<void>;
}

export async function startFakeServer(script: Script, options: { rejectStatus?: number } = {}): Promise<FakeServer> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const received: unknown[] = [];
  const requests: IncomingMessage[] = [];
  http.on("upgrade", (req, socket, head) => {
    requests.push(req);
    if (options.rejectStatus) {
      socket.end(`HTTP/1.1 ${options.rejectStatus} Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "session.created", event_id: "evt_0", session: { type: "realtime" } }));
      ws.on("message", (data) => {
        const event = JSON.parse(data.toString()) as { type: string };
        received.push(event);
        if (event.type === "response.create") script(ws, received);
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/v1/realtime`,
    received,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        http.close(() => resolve());
      }),
  };
}

let n = 0;
const id = () => `evt_${++n}`;

/** Sends `pcm` as base64 audio deltas of `chunk` bytes, a transcript, and response.done with `status`. */
export function reply(
  socket: WebSocket, pcm: Buffer, transcript: string, status: "completed" | "failed" | "incomplete" = "completed",
  chunk = 4800,
): void {
  const base = { response_id: "resp_1", item_id: "item_1", output_index: 0, content_index: 0 };
  socket.send(JSON.stringify({ type: "response.created", event_id: id(), response: { id: "resp_1", status: "in_progress" } }));
  for (let i = 0; i < pcm.length; i += chunk) {
    socket.send(JSON.stringify({ type: "response.output_audio.delta", event_id: id(), ...base,
      delta: pcm.subarray(i, i + chunk).toString("base64") }));
  }
  socket.send(JSON.stringify({ type: "response.output_audio_transcript.delta", event_id: id(), ...base, delta: transcript }));
  socket.send(JSON.stringify({ type: "response.output_audio.done", event_id: id(), ...base }));
  socket.send(JSON.stringify({
    type: "response.done", event_id: id(),
    response: {
      id: "resp_1", status,
      ...(status === "completed" ? {} : { status_details: { type: status, reason: "max_output_tokens" } }),
    },
  }));
}

export function sendError(socket: WebSocket, message: string, code: string): void {
  socket.send(JSON.stringify({ type: "error", event_id: id(), error: { type: "invalid_request_error", code, message } }));
}
