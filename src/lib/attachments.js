// Mirrors server/fileExtract.js's ALLOWED_EXTENSIONS/MAX_ATTACHMENT_BYTES —
// this is a client-side convenience check only; the server enforces both
// independently and is the actual authority.
export const ALLOWED_ATTACHMENT_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function attachmentError(file) {
  const ext = `.${(file.name.split('.').pop() || '').toLowerCase()}`;
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext)) {
    return `Unsupported file type "${ext}" — allowed: ${ALLOWED_ATTACHMENT_EXTENSIONS.join(', ')}`;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `File exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB limit`;
  }
  return null;
}
