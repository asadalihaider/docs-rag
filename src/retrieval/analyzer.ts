/**
 * Lexical analysis shared by the BM25 index and by the Postgres term table.
 *
 * The exact same pipeline must run at index time and at query time, in both the
 * in-memory store and the Postgres store — otherwise BM25 silently degrades
 * because query terms never match indexed terms. That is why this lives in one
 * file with no dependencies, and why `PgVectorStore` writes analyzed terms into
 * `chunk_terms` rather than relying on Postgres' own `to_tsvector`.
 */

/**
 * A small, deliberately conservative English stop list. Documentation queries
 * are short, so dropping too much hurts; these are terms with near-zero
 * discriminative power in a developer-docs corpus.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

/**
 * Conservative suffix stripping (a cut-down Porter step 1).
 *
 * Full Porter stemming is too aggressive for technical docs — it collapses
 * `caching`/`cache` correctly but also mangles identifiers. We only handle the
 * plural/gerund/past-tense endings that actually cause query/document
 * mismatches ("retries" vs "retry", "scheduling" vs "schedule"), and we refuse
 * to stem anything under 4 characters or containing a digit.
 */
export function stem(term: string): string {
  if (term.length < 4 || /\d/.test(term)) return term;

  if (term.endsWith('ies') && term.length > 4) return term.slice(0, -3) + 'y';
  if (term.endsWith('sses')) return term.slice(0, -2);
  if (term.endsWith('ses') && term.length > 4) return term.slice(0, -2);
  if (term.endsWith('xes') || term.endsWith('ches') || term.endsWith('shes')) {
    return term.slice(0, -2);
  }
  if (term.endsWith('s') && !term.endsWith('ss') && !term.endsWith('us')) return term.slice(0, -1);

  if (term.endsWith('ing') && term.length > 5) {
    const base = term.slice(0, -3);
    // "scheduling" -> "schedul" -> "schedule"; restore the dropped silent e.
    return /[aeiou]/.test(base) ? restoreE(base) : term;
  }
  if (term.endsWith('ed') && term.length > 4) {
    const base = term.slice(0, -2);
    return /[aeiou]/.test(base) ? restoreE(base) : term;
  }
  return term;
}

function restoreE(base: string): string {
  // Words whose stem ends in a consonant cluster that cannot end a syllable
  // almost always lost a silent 'e' (schedul -> schedule, us -> use).
  if (/(bl|cl|dl|gl|pl|tl|vl|ul|at|iz|iv|us|ur|as|ac|ag|ic)$/.test(base)) return base + 'e';
  return base;
}

/** Split camelCase / PascalCase so `maxRetries` also matches "max" and "retries". */
function splitCamel(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * Tokenise text into normalised, stemmed terms.
 *
 * Dotted / hyphenated identifiers (`larkspur.yaml`, `--dry-run`) are emitted
 * both whole and split, so a query for "larkspur.yaml" and a query for "yaml"
 * both hit. Duplicates are intentional — BM25 wants raw term frequencies.
 */
export function analyze(text: string): string[] {
  const normalized = splitCamel(text).toLowerCase();
  const out: string[] = [];

  // Grab identifier-ish runs first (word chars plus . _ - /), then split them.
  const raw = normalized.match(/[a-z0-9][a-z0-9._/-]*[a-z0-9]|[a-z0-9]/g) ?? [];

  for (const token of raw) {
    const parts = token.split(/[._/-]+/).filter(Boolean);
    if (parts.length > 1) {
      // Keep the compound form as its own term — exact identifier matches are
      // high-signal and should not be diluted away.
      const compound = token.replace(/[._/-]+/g, '');
      if (compound.length >= 2 && !STOPWORDS.has(compound)) out.push(compound);
    }
    for (const part of parts) {
      if (part.length < 2) continue;
      if (STOPWORDS.has(part)) continue;
      out.push(stem(part));
    }
  }
  return out;
}

/** Deduplicated analysis, for query expansion where repetition is meaningless. */
export function analyzeUnique(text: string): string[] {
  return [...new Set(analyze(text))];
}

/** Term frequency map for a single document. */
export function termFrequencies(terms: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
  return tf;
}
