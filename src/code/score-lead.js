//@include score-rules.fn.js

const { lead } = $input.first().json;
const result = scoreLeadRules(lead);
return [{ json: { lead, ...result, scored_by: 'rules' } }];
