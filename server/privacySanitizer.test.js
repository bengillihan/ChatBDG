import { describe, expect, it } from 'vitest';
import { sanitizeCloudText } from './privacySanitizer.js';

describe('sanitizeCloudText', () => {
  it('removes names and email addresses found in message headers and prose', () => {
    const original = `From: Dan Brewer <danb@example.org>
To: Geoff Allan <geoff@example.net>
Cc: Jeff Moorehead <jeff@example.org>; Rick Monzon <rick@example.net>

Geoff, Rachel also asked Dan for clarity. Pastor Jeff spoke with Rick.`;
    const draft = 'Geoff asked Dan Brewer whether Rachel, Jeff Moorehead, and Rick Monzon could meet. Email danb@example.org.';

    const result = sanitizeCloudText(draft, original);

    for (const secret of ['Geoff', 'Dan', 'Brewer', 'Rachel', 'Jeff', 'Moorehead', 'Rick', 'Monzon', 'danb@example.org']) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain('Person');
    expect(result).toContain('[email removed]');
  });

  it('preserves numbered placeholders and non-identifying theological terms', () => {
    const result = sanitizeCloudText('Person 1 asked Person 2 what Scripture says about Jesus and the Church.');

    expect(result).toBe('Person 1 asked Person 2 what Scripture says about Jesus and the Church.');
  });

  it('uses the original conversation to catch a name reintroduced into an edited draft', () => {
    const result = sanitizeCloudText('Please give Miriam practical advice.', 'The user is seeking advice for Miriam Solace.');

    expect(result).toBe('Please give Person practical advice.');
  });

  it('redacts names containing non-ASCII letters and case-insensitive edits', () => {
    const result = sanitizeCloudText('josé should respond.', 'I spoke with José Álvarez.');

    expect(result).not.toMatch(/josé|álvarez/iu);
    expect(result).toContain('Person');
  });
});
