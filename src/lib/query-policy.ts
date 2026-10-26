const greetingPattern = /^(?:(?:hi|hello|hey)(?: there)?|good morning|good afternoon|good evening|good night|how are you(?: doing)?)[!.?,\s]*$/i;
const courtesyPattern = /^(?:thanks|thank you|thanks a lot|that is helpful|that's helpful|got it|okay|ok|bye|goodbye)[!.?,\s]*$/i;
const outOfScopePatterns = [
  /\b(?:weather|forecast)\b/i,
  /\b(?:tell|share|give)\s+me\s+(?:a\s+)?(?:joke|riddle)\b|\b(?:joke|riddle)\s+please\b/i,
  /\b(?:recipe|recipes|cooking instructions?|meal plan)\b/i,
  /\b(?:write|generate|debug|fix|review)\b.{0,50}\b(?:code|script|program|python|javascript|typescript|java|c\+\+)\b/i,
  /\b(?:python|javascript|typescript|java|c\+\+)\s+(?:code|script|program)\b/i,
  /\b(?:capital|president|prime minister|population)\s+(?:of|for)\b|\bwho is (?:the )?(?:president|prime minister|king|queen)\b/i,
  /\b(?:sports? scores?|football match|cricket match|basketball game|lottery numbers?)\b/i,
  /\b(?:stock price|crypto(?:currency)? price|bitcoin price|live exchange rate)\b/i,
  /\b(?:write|create|tell me)\s+(?:a\s+)?(?:fictional\s+)?(?:poem|short story|fairy tale)\b/i,
  /\bsolve\b.{0,30}\b(?:equation|integral|derivative|math problem)\b/i,
];

const documentRedirectMessage =
  "I’m here to answer questions grounded in the Silverline sample documents, including board minutes, resolutions, and financial results. Ask about a recorded decision, attendee, financial figure, audit note, or document detail, and I’ll look for it in the sources.";
const greetingRedirectMessage =
  `Hello! ${documentRedirectMessage}`;
const courtesyRedirectMessage =
  "You’re welcome! Whenever you’re ready, ask me about the Silverline sample documents—such as board decisions, financial results, or audit notes.";
const outOfScopeRedirectMessage =
  "I can’t help with that request because it’s outside this assistant’s scope. I can answer questions using the Silverline sample documents, including board minutes, resolutions, and financial results.";

export type QueryPolicyDecision =
  | { allowed: true }
  | { allowed: false; answer: string };

export function applyQueryPolicy(message: string): QueryPolicyDecision {
  const normalized = message.trim();
  if (greetingPattern.test(normalized)) {
    return {
      allowed: false,
      answer: greetingRedirectMessage,
    };
  }

  if (courtesyPattern.test(normalized)) {
    return { allowed: false, answer: courtesyRedirectMessage };
  }

  if (outOfScopePatterns.some((pattern) => pattern.test(normalized))) {
    return { allowed: false, answer: outOfScopeRedirectMessage };
  }

  return { allowed: true };
}