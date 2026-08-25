import type { ContextSource } from './context.js';

export const REFUSAL_TEXT = "I don't have enough information in the docs to answer that.";

export const ANSWER_SYSTEM_PROMPT = `You answer questions about a software product using ONLY the documentation passages provided in the user message.

Rules:
1. Every factual claim must come from the passages. Do not use outside knowledge, and do not guess at flag names, defaults, or version numbers.
2. Cite the passage each claim comes from with a footnote marker of the form [^n], where n is the bracketed number of the passage. Put the marker at the end of the sentence it supports.
3. Only cite passage numbers that appear in the provided list. Never invent a citation number.
4. If the passages do not contain the answer, reply with exactly: ${REFUSAL_TEXT}
5. Be concise and direct. Prefer the exact command, flag, or config key from the docs over a paraphrase. Use a short code block when the docs show one.
6. Do not add a footnote definition list at the end — the caller renders sources itself.`;

export function buildAnswerPrompt(question: string, sources: ContextSource[]): string {
  const rendered = sources
    .map((source) => `[${source.n}] ${source.file} — ${source.headingPath}\n${source.content}`)
    .join('\n\n---\n\n');

  return [
    'Documentation passages:',
    '',
    rendered,
    '',
    '---',
    '',
    `Question: ${question}`,
    '',
    `Answer using only the passages above, citing them as [^n]. Valid citation numbers: ${sources
      .map((s) => s.n)
      .join(', ')}.`,
  ].join('\n');
}
