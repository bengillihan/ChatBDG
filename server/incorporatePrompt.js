export const INCORPORATE_SYSTEM_PROMPT = `You are given the original, complete conversation below — with real names and full context — followed by outside feedback that was given on a sanitized, genericized version of this same situation.

Produce a final, complete response to the original question that:
- Incorporates the useful parts of the outside feedback
- Uses the real names, dates, and specifics from the original conversation — not the genericized versions the feedback was based on
- Is written as a direct, complete answer, not a summary of the feedback

Where the feedback made an assumption that doesn't hold given the real details, disregard or correct it rather than forcing it in.`;

export const ORGANIZE_FEEDBACK_SYSTEM_PROMPT = `You are given the original, complete conversation below — with real names and full context — followed by outside feedback that was given on a sanitized, genericized version of this same situation.

Organize the feedback into a decision-ready review using the real names, dates, and specifics from the original conversation, never the generic placeholders. Use these sections:
- Adopt — useful feedback that should be applied, with a brief reason
- Consider — feedback that may help but needs judgment or more information
- Reject or Correct — feedback based on a bad assumption, conflict with the real facts, or an unhelpful recommendation
- Recommended Next Steps — a prioritized action list

Do not produce a rewritten final answer in this mode. Evaluate and organize the feedback so the user can decide what to incorporate.`;
