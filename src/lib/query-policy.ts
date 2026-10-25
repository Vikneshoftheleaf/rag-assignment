const inScopePatterns = [
  /\bsilverline\b/i,
  /\bboard\b/i,
  /\bmeeting\b/i,
  /\bminutes\b/i,
  /\bresolution(?:s)?\b/i,
  /\bcertified true cop(?:y|ies)\b/i,
  /\bregister\b/i,
  /\battend(?:ed|ance|ee|ees|ing)?\b/i,
  /\bdirectors?\b/i,
  /\bagenda\b/i,
  /\baction items?\b/i,
  /\bdecisions?\b/i,
  /\bapprov(?:e|ed|al|als)\b/i,
  /\breports?\b/i,
  /\bresults?\b/i,
  /\baudit(?:or|ors|ed|ing)?\b/i,
  /\bfinancial(?:s)?\b/i,
  /\brevenue\b/i,
  /\bexpenses?\b/i,
  /\bprofits?\b/i,
  /\bloss(?:es)?\b/i,
  /\bbalance sheet\b/i,
  /\bcash flow\b/i,
  /\bquarter(?:ly)?\b/i,
  /\bhalf[- ]year\b/i,
  /\b(?:q[1-4]|h[1-2])\b/i,
  /\b(?:q[1-4]|h[1-2])\s*(?:fy)?\s*20\d{2}(?:[-/]\d{2,4})?\b/i,
  /\bfy\s*20\d{2}(?:[-/]\d{2,4})?\b/i,
  /\bboard records?\b/i,
  /\b(?:these|those|the|this)\s+(?:sample\s+)?(?:documents?|docs|files|records|sources|corpus)\b/i,
  /\b(?:in|from|across|among)\s+(?:the\s+)?(?:sample\s+)?(?:documents?|docs|files|records|sources)\b/i,
  /\b(?:document|file|record|source)\s+(?:says?|states?|reports?|mentions?|contains?)\b/i,
];

const greetingPattern = /^(?:hi|hello|hey|good morning|good afternoon|good evening|how are you)[!.?\s]*$/i;

const redirectMessage =
  "I’m here to answer questions grounded in the Silverline sample documents, including board minutes, resolutions, and financial results. Ask about a recorded decision, attendee, financial figure, audit note, or document detail, and I’ll look for it in the sources.";

export type QueryPolicyDecision =
  | { allowed: true }
  | { allowed: false; answer: string };

export function applyQueryPolicy(message: string): QueryPolicyDecision {
  const normalized = message.trim();
  if (greetingPattern.test(normalized)) {
    return {
      allowed: false,
      answer: `Hello! ${redirectMessage}`,
    };
  }

  if (inScopePatterns.some((pattern) => pattern.test(normalized))) {
    return { allowed: true };
  }

  return { allowed: false, answer: redirectMessage };
}