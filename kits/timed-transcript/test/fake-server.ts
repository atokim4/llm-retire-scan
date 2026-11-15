import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readWav } from "../src/pcm.ts";

export interface Captured {
  path: string;
  authorization: string | undefined;
  /** Every form field but the file, as name -> values. */
  fields: Record<string, string[]>;
  fileName: string;
  fileType: string;
  /** Length of the uploaded WAV, seconds. */
  seconds: number;
}

export type Reply = (request: Captured, index: number) => Promise<{ status?: number; headers?: Record<string, string>; body: unknown }>
  | { status?: number; headers?: Record<string, string>; body: unknown };

/** A stand-in for /v1/audio/transcriptions that records every multipart request it gets. */
export async function startFakeApi(reply: Reply) {
  const requests: Captured[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = await new Request("http://local", {
        method: "POST", headers: { "content-type": req.headers["content-type"] ?? "" }, body: Buffer.concat(chunks),
      }).formData();
      const fields: Record<string, string[]> = {};
      let file: File | undefined;
      for (const [name, value] of form.entries()) {
        if (typeof value === "string") (fields[name] ??= []).push(value);
        else file = value;
      }
      const captured: Captured = {
        path: req.url ?? "",
        authorization: req.headers.authorization,
        fields,
        fileName: file?.name ?? "",
        fileType: file?.type ?? "",
        seconds: 0,
      };
      if (file) {
        const pcm = readWav(new Uint8Array(await file.arrayBuffer()));
        captured.seconds = pcm.samples.length / pcm.sampleRate;
      }
      const index = requests.push(captured) - 1;
      const answer = await reply(captured, index);
      res.writeHead(answer.status ?? 200, { "content-type": "application/json", ...answer.headers });
      res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    } catch (error) {
      res.writeHead(599);
      res.end(String(error));
    } finally {
      inFlight--;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    maxInFlight: () => maxInFlight,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
