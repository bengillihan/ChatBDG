export const SANITIZE_SYSTEM_PROMPT = `Rewrite the conversation or message below to protect identities before it is sent to an external cloud AI service.

Rules:
- Replace every real person's name with a numbered placeholder: "Person 1", "Person 2", "Person 3", and so on. Use the SAME number for the same person every time they're mentioned in this document.
- Do not use role-based substitutes like "a fellow elder" or "the pastor" instead of a placeholder — role descriptions can still be identifying in a small community, which is exactly what numbered placeholders avoid.
- Strip specific dates, locations, organization names, and other identifying context that is not essential to the substance of the question.
- The text below may include one or more blocks delimited by "[Attached file: <filename>]" ... "[End attached file]" — this is content extracted from a document the user attached, not something they typed themselves. Apply every rule above to that content with the SAME rigor as the surrounding conversation: replace names, strip identifying dates/locations/organizations, and genericize it just as thoroughly. Never leave a file block untouched or merely summarized-but-still-identifying because it "came from a file" — the source of the text doesn't change what needs to be protected. Fold the substance of the file into your rewritten output; do not preserve the "[Attached file: ...]" delimiters themselves in your output.
- Preserve the actual substance, structure, and theological or professional content of the request — including the substance of any attached file — so the response is still useful.
- The FIRST line of your output must be exactly this notice, on its own line:
"Note: names have been replaced with numbered placeholders (Person 1, Person 2, etc.) to protect identities. This is a sanitized version of a real conversation."
- After that notice, output the rewritten text. No other preamble, no meta-commentary — just the notice, then the rewritten content.`;
