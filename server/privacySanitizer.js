const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;

// Words that are commonly capitalized in prose but are not identifying people.
// The detector is deliberately conservative around high-confidence name
// shapes because this function guards a cloud boundary.
const SAFE_CAPITALIZED_WORDS = new Set([
  'A', 'An', 'And', 'Are', 'As', 'At', 'Be', 'Because', 'Below', 'But', 'By',
  'Can', 'Could', 'Dear', 'Do', 'Does', 'For', 'From', 'Good', 'Has', 'Have',
  'He', 'Her', 'Here', 'Him', 'His', 'How', 'I', 'If', 'In', 'Is', 'It', 'Its',
  'May', 'My', 'No', 'Not', 'Of', 'On', 'Or', 'Our', 'Please', 'Re', 'Regarding',
  'She', 'Since', 'So', 'Subject', 'That', 'The', 'Their', 'There', 'These',
  'They', 'This', 'Those', 'To', 'Tuesday', 'User', 'We', 'What', 'When', 'Where',
  'Which', 'While', 'Who', 'Why', 'Will', 'With', 'Would', 'You', 'Your',
  // Preserve common theological terms; these do not identify the people in
  // the user's situation and removing them would materially change meaning.
  'Bible', 'Biblical', 'Christ', 'Christian', 'Church', 'Discipline', 'Elders',
  'Father', 'God', 'Holy', 'Jesus', 'Lord', 'Reconciliation', 'Scriptural',
  'Scripture', 'Spirit', 'Trinity',
  'Corinthians', 'Ephesians', 'Galatians', 'Genesis', 'Hebrews', 'James',
  'Matthew', 'Peter', 'Proverbs', 'Timothy',
  'January', 'February', 'March', 'April', 'June', 'July', 'August', 'September',
  'October', 'November', 'December', 'Monday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday',
  // These are the only person-like labels allowed across the boundary.
  'Person'
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateNames(text) {
  const candidates = new Set();

  // Email display names and message headers are high-confidence sources.
  for (const match of text.matchAll(/(?:^|\n)(?:From|To|Cc):\s*([^\n]+)/giu)) {
    const header = match[1].replace(EMAIL_PATTERN, ' ');
    for (const name of header.matchAll(/(?<![\p{L}\p{N}_])[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)*(?![\p{L}\p{N}_])/gu)) {
      for (const part of name[0].split(/\s+/u)) candidates.add(part);
    }
  }

  // Full names, direct salutations, possessives, and relationship wording
  // catch personal names even when they appear only once.
  const highConfidencePatterns = [
    /(?<![\p{L}\p{N}_])[\p{Lu}][\p{L}'’-]+\s+[\p{Lu}][\p{L}'’-]+(?![\p{L}\p{N}_])/gu,
    /(?:^|\n)\s*([\p{Lu}][\p{L}'’-]+)\s*[:,]/gu,
    /(?<![\p{L}\p{N}_])([\p{Lu}][\p{L}'’-]+)[’']s(?![\p{L}\p{N}_])/gu,
    /\b(?:wife|husband|spouse|son|daughter|pastor|elder|counselor)\s+([\p{Lu}][\p{L}'’-]+)(?![\p{L}\p{N}_])/giu,
    /\b(?:with|for|about|regarding|concerning)\s+([\p{Lu}][\p{L}'’-]+)(?![\p{L}\p{N}_])/gu
  ];
  for (const pattern of highConfidencePatterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] || match[0];
      for (const part of value.trim().split(/\s+/u)) candidates.add(part);
    }
  }

  // A personal first name usually recurs in a conversation. Treat repeated
  // capitalized words as possible names, while retaining a small allow-list.
  const counts = new Map();
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])[\p{Lu}][\p{L}'’-]{1,}(?![\p{L}\p{N}_])/gu)) {
    counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  }
  for (const [word, count] of counts) {
    if (count > 1) candidates.add(word);
  }

  return [...candidates].filter((word) => !SAFE_CAPITALIZED_WORDS.has(word));
}

/**
 * Locally removes possible personal names and direct contact identifiers.
 * Reference text may contain the original conversation, allowing the final
 * cloud-bound draft to be checked against names the first model was meant to
 * remove. No network service is involved.
 */
export function sanitizeCloudText(text, referenceText = '') {
  const combined = `${referenceText}\n${text}`;
  let sanitized = text.replace(EMAIL_PATTERN, '[email removed]');
  const names = candidateNames(combined).sort((a, b) => b.length - a.length);

  for (const name of names) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?:[’']s)?(?![\\p{L}\\p{N}_])`,
      'giu'
    );
    sanitized = sanitized.replace(pattern, 'Person');
  }

  return sanitized;
}
