export interface SSEEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

const MAX_SSE_EVENT_CHARS = 8_000_000;
const MAX_SSE_LINE_CHARS = MAX_SSE_EVENT_CHARS + 16;

function parseField(line: string): { field: string; value: string } {
  const separator = line.indexOf(':');
  if (separator === -1) return { field: line, value: '' };
  const field = line.slice(0, separator);
  const value = line.startsWith(':', separator + 1) ? line.slice(separator + 1) : line.slice(separator + 1).replace(/^ /, '');
  return { field, value };
}

/**
 * Parse a browser-style Server-Sent Events stream without assuming that chunks
 * align with lines or events. The generator also flushes a final unterminated
 * event, which is common when an upstream closes immediately after its last
 * data line.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let dataCharacters = 0;

  const dispatch = (): SSEEvent | null => {
    if (dataLines.length === 0 && event === undefined && id === undefined && retry === undefined) return null;
    const result: SSEEvent = {
      data: dataLines.join('\n'),
      ...(event !== undefined ? { event } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(retry !== undefined ? { retry } : {}),
    };
    dataLines = [];
    dataCharacters = 0;
    event = undefined;
    id = undefined;
    retry = undefined;
    return result;
  };

  const consumeLine = (rawLine: string): SSEEvent | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return dispatch();
    if (line.startsWith(':')) return null;

    const { field, value } = parseField(line);
    switch (field) {
      case 'data':
        dataCharacters += value.length;
        if (dataCharacters > MAX_SSE_EVENT_CHARS) throw new Error('SSE event exceeds the maximum size');
        dataLines.push(value);
        break;
      case 'event': event = value; break;
      case 'id': if (!value.includes('\u0000')) id = value; break;
      case 'retry': {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
        break;
      }
      default: break;
    }
    return null;
  };

  const abortReader = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  if (signal) signal.addEventListener('abort', abortReader, { once: true });
  let reachedEndOfStream = false;

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      if (done) { reachedEndOfStream = true; break; }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        if (newlineIndex > MAX_SSE_LINE_CHARS) throw new Error('SSE line exceeds the maximum size');
        const eventResult = consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        if (eventResult) yield eventResult;
        newlineIndex = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_SSE_LINE_CHARS) throw new Error('SSE line exceeds the maximum size');
    }

    buffer += decoder.decode();
    if (buffer.length > MAX_SSE_LINE_CHARS) throw new Error('SSE line exceeds the maximum size');
    if (buffer.length > 0) {
      const eventResult = consumeLine(buffer);
      if (eventResult) yield eventResult;
    }
    const finalEvent = dispatch();
    if (finalEvent) yield finalEvent;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    if (!reachedEndOfStream) {
      try { await reader.cancel(); } catch {}
    }
    reader.releaseLock();
  }
}
