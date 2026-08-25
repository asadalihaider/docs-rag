import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const EvalQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  /** Files that genuinely answer the question. Retrieval is correct if it finds any of them. */
  expected_files: z.array(z.string()).min(1),
  /** Optional heading path substring, used for a stricter section-level check. */
  expected_heading: z.string().optional(),
  /** Free-text note explaining why the question is interesting. */
  note: z.string().optional(),
});

export type EvalQuestion = z.infer<typeof EvalQuestionSchema>;

/** Read a JSONL question set, skipping blank lines and `#` comments. */
export async function loadQuestions(path: string): Promise<EvalQuestion[]> {
  const raw = await readFile(path, 'utf8');
  const questions: EvalQuestion[] = [];

  raw.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `${path}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = EvalQuestionSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `${path}:${index + 1} is not a valid question: ${result.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }
    questions.push(result.data);
  });

  return questions;
}
