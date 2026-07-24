import { describe, expect, it } from 'vitest';
import { isAllowedFilename, extractText, wrapAttachment, MAX_EXTRACTED_CHARS } from './fileExtract.js';

describe('isAllowedFilename', () => {
  it('accepts the allowed extensions', () => {
    expect(isAllowedFilename('report.pdf')).toBe(true);
    expect(isAllowedFilename('report.docx')).toBe(true);
    expect(isAllowedFilename('notes.txt')).toBe(true);
    expect(isAllowedFilename('notes.md')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAllowedFilename('archive.zip')).toBe(false);
    expect(isAllowedFilename('program.exe')).toBe(false);
    expect(isAllowedFilename('noextension')).toBe(false);
  });
});

describe('extractText', () => {
  it('reads plain text files directly', async () => {
    const text = await extractText(Buffer.from('hello world'), 'notes.txt');
    expect(text).toBe('hello world');
  });

  it('reads markdown files directly', async () => {
    const text = await extractText(Buffer.from('# heading\n\nbody'), 'notes.md');
    expect(text).toBe('# heading\n\nbody');
  });

  it('throws a clear error when the file has no extractable text', async () => {
    await expect(extractText(Buffer.from('   \n  '), 'empty.txt')).rejects.toThrow(/no extractable text/);
  });

  it('truncates text past the extraction cap instead of passing it through unbounded', async () => {
    const huge = 'x'.repeat(MAX_EXTRACTED_CHARS + 5000);
    const text = await extractText(Buffer.from(huge), 'huge.txt');
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain('truncated');
  });
});

describe('wrapAttachment', () => {
  it('delimits the file content so the model can tell it apart from typed text', () => {
    const wrapped = wrapAttachment('notes.txt', 'the body');
    expect(wrapped).toBe('[Attached file: notes.txt]\nthe body\n[End attached file]');
  });
});
