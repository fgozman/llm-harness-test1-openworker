// A tiny scripted stand-in for the OpenAI Responses API (streaming), used by
// the integration test. Each request gets the next scripted step: either one
// function call or a final text message.
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockStep =
  | { call: string; args: Record<string, unknown> }
  | { text: string };

export interface MockServer {
  /** Base URL to use as the provider's baseUrl. */
  url: string;
  /** Headers of every request received. */
  requests: IncomingHttpHeaders[];
  close(): Promise<void>;
}

export async function startMockResponsesServer(steps: MockStep[]): Promise<MockServer> {
  const requests: IncomingHttpHeaders[] = [];

  const server: Server = createServer((req, res) => {
    req.resume(); // the request body is not needed
    req.on('end', () => {
      requests.push(req.headers);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [type, data] of eventsFor(step, requests.length)) {
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      }
      res.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

type SseEvent = [type: string, data: Record<string, unknown>];

/** The SSE events for one streamed response containing a single output item. */
function eventsFor(step: MockStep, n: number): SseEvent[] {
  const response = { id: `resp_${n}`, object: 'response', status: 'in_progress', model: 'mock', output: [] };
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

  if ('call' in step) {
    const args = JSON.stringify(step.args);
    const item = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: step.call, arguments: args };
    return [
      ['response.created', { response }],
      ['response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }],
      ['response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: args }],
      ['response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: args }],
      ['response.output_item.done', { output_index: 0, item: { ...item, status: 'completed' } }],
      ['response.completed', { response: { ...response, status: 'completed', output: [{ ...item, status: 'completed' }], usage } }],
    ];
  }

  const content = { type: 'output_text', text: step.text, annotations: [] };
  const item = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [content] };
  const part = { item_id: item.id, output_index: 0, content_index: 0 };
  return [
    ['response.created', { response }],
    ['response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.content_part.added', { ...part, part: { type: 'output_text', text: '' } }],
    ['response.output_text.delta', { ...part, delta: step.text }],
    ['response.output_text.done', { ...part, text: step.text }],
    ['response.output_item.done', { output_index: 0, item }],
    ['response.completed', { response: { ...response, status: 'completed', output: [item], usage } }],
  ];
}
