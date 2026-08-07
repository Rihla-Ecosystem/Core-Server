const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts|rules|directions)/i,
  /you\s+are\s+(now|no longer)\s+/i,
  /system\s+prompt/i,
  /forget\s+(everything|all|previous)/i,
  /new\s+instruction/i,
  /override\s+(your|all|previous)/i,
  /reveal\s+(your|the)\s+(system|internal|prompt|secret|key|token)/i,
  /print\s+your\s+(system|instructions)/i,
  /dan\s*:|do\s+anything\s+now/i,
];

export function detectPromptInjection(input: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(input);
    if (match) return match[0];
  }
  return null;
}
