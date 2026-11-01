// Build the draft the human approver will read. Nothing is sent from here.
const { lead, fit_score, tier, reasons, scored_by } = $input.first().json;
const clean = (s) => String(s).replace(/[\r\n\t]+/g, ' ').trim();
const first = clean(lead.name).split(/\s+/)[0];

const draft_subject = clean(`Re: your enquiry from ${lead.company}`).slice(0, 150);
const draft_body =
  `Hi ${first},\n\n` +
  `Thanks for getting in touch${lead.title ? ` (${clean(lead.title)} at ${clean(lead.company)})` : ''}. ` +
  `I read your note and I think a short call is the quickest way to see whether I can help.\n\n` +
  `Would a 20 minute call this week suit you?\n\nBest regards`;

return [{ json: { lead, fit_score, tier, reasons, scored_by, draft_subject, draft_body } }];
