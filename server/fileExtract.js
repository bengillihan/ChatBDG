import path from 'node:path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 50_000;
export const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];

export function isAllowedFilename(filename) {
  return ALLOWED_EXTENSIONS.includes(path.extname(filename || '').toLowerCase());
}

// Only PDF/Word need real parsing — plain text/markdown are read as-is.
// A file with no extractable text (e.g. a scanned, image-only PDF) throws
// rather than silently attaching empty content that would look to the model
// like the user just sent nothing.
export async function extractText(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  let text;

  if (ext === '.pdf') {
    const result = await pdfParse(buffer);
    text = result.text;
  } else if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else if (ext === '.txt' || ext === '.md') {
    text = buffer.toString('utf-8');
  } else {
    throw new Error(`unsupported file type: ${ext || 'unknown'}`);
  }

  text = text.trim();
  if (!text) {
    throw new Error('no extractable text found in this file (it may be a scanned or image-only document)');
  }
  if (text.length > MAX_EXTRACTED_CHARS) {
    text = `${text.slice(0, MAX_EXTRACTED_CHARS)}\n[...truncated, extracted text exceeded ${MAX_EXTRACTED_CHARS} characters]`;
  }
  return text;
}

export function wrapAttachment(filename, extractedText) {
  return `[Attached file: ${filename}]\n${extractedText}\n[End attached file]`;
}
