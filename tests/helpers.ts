import { sha256 } from '../src/util/hash.js';
import type { ChatModel, ChatRequest, ChatResponse, SourceDocument } from '../src/types.js';

/** Build a `SourceDocument` from raw markdown without touching the filesystem. */
export function makeDoc(id: string, body: string, title = id): SourceDocument {
  return {
    id,
    absolutePath: `/virtual/${id}`,
    title,
    frontmatter: {},
    body,
    contentHash: sha256(body),
  };
}

/**
 * A `ChatModel` that returns whatever you tell it to, so tests can drive the
 * citation-verification and refusal paths deterministically.
 */
export class ScriptedChat implements ChatModel {
  readonly id = 'scripted';
  readonly requests: ChatRequest[] = [];

  constructor(private readonly reply: string | ((req: ChatRequest) => string)) {}

  private render(req: ChatRequest): string {
    return typeof this.reply === 'function' ? this.reply(req) : this.reply;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const text = this.render(req);
    return { text, promptTokens: 100, completionTokens: 20 };
  }

  async *stream(req: ChatRequest): AsyncIterable<string> {
    this.requests.push(req);
    for (const word of this.render(req).split(/(?<=\s)/)) yield word;
  }
}
