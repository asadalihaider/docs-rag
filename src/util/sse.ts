/**
 * Minimal Server-Sent Events parser for `fetch` response bodies.
 *
 * Both the Anthropic and OpenAI streaming endpoints speak SSE, and both can
 * split a single event across TCP chunks — so buffering until a blank-line
 * terminator is not optional. Yields one parsed event per `event:`/`data:` block.
 */
export interface SseEvent {
  event: string | undefined;
  data: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseBlock(raw);
        if (parsed) yield parsed;
        boundary = buffer.indexOf('\n\n');
      }
    }
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(raw: string): SseEvent | null {
  const lines = raw.split('\n');
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment / keep-alive
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0 && event === undefined) return null;
  return { event, data: dataLines.join('\n') };
}
