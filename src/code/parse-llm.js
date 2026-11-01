//@include score-rules.fn.js

// Take the LLM answer if it is well-formed; otherwise fall back to the rules.
const { lead } = $('Validate lead').first().json;
const clean = (s) => String(s).replace(/[\r\n\t]+/g, ' ').trim();
const response = $input.first().json;

let parsed = null;
let failure = null;
if (response.error) {
  failure = `llm_request_failed: ${clean(response.error.message || response.error).slice(0, 120)}`;
} else {
  try {
    const content = response.choices[0].message.content;
    parsed = JSON.parse(content);
  } catch (e) {
    failure = 'llm_answer_not_json';
  }
}
if (parsed) {
  const okScore = typeof parsed.fit_score === 'number' && parsed.fit_score >= 0 && parsed.fit_score <= 100;
  const okDraft =
    typeof parsed.draft_subject === 'string' && parsed.draft_subject.trim().length > 0 &&
    typeof parsed.draft_body === 'string' && parsed.draft_body.trim().length > 0;
  if (!okScore) failure = 'llm_score_out_of_range';
  else if (!okDraft) failure = 'llm_draft_missing';
}

if (failure) {
  const rules = scoreLeadRules(lead);
  const first = clean(lead.name).split(/\s+/)[0];
  return [{
    json: {
      lead, ...rules, scored_by: 'rules-fallback', fallback_reason: failure,
      draft_subject: clean(`Re: your enquiry from ${lead.company}`).slice(0, 150),
      draft_body: `Hi ${first},\n\nThanks for getting in touch. Would a 20 minute call this week suit you?\n\nBest regards`,
    },
  }];
}

const score = Math.round(parsed.fit_score);
const tier = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
return [{
  json: {
    lead, fit_score: score, tier,
    reasons: [clean(parsed.rationale || 'no rationale').slice(0, 300)],
    scored_by: 'llm',
    draft_subject: clean(parsed.draft_subject).slice(0, 150),
    draft_body: String(parsed.draft_body).slice(0, 4000),
  },
}];
