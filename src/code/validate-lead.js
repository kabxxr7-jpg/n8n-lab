// Validate and normalise the lead posted to the intake webhook.
const body = $input.first().json.body;
const errors = [];

if (body === null || typeof body !== 'object' || Array.isArray(body)) {
  return [{ json: { valid: false, errors: ['body must be a JSON object'] } }];
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const name = str(body.name);
const email = str(body.email).toLowerCase();
const company = str(body.company);
const title = str(body.title);
const message = str(body.message);

if (name.length < 2 || name.length > 100) errors.push('name must be 2-100 characters');
if (email.length > 254 || !/^[^\s@<>,;:"']+@[^\s@<>,;:"']+\.[a-z]{2,}$/i.test(email)) {
  errors.push('email is not a valid address');
}
if (company.length < 1 || company.length > 120) errors.push('company must be 1-120 characters');
if (title.length > 100) errors.push('title must be at most 100 characters');
if (message.length > 2000) errors.push('message must be at most 2000 characters');
if (/[\r\n]/.test(name + company + title)) errors.push('no line breaks allowed in name, company or title');

const optionalNumber = (value, field, { integer, min, max }) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    errors.push(`${field} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
    return null;
  }
  return n;
};
const employees = optionalNumber(body.employees, 'employees', { integer: true, min: 1, max: 1000000 });
const budget_usd = optionalNumber(body.budget_usd, 'budget_usd', { integer: false, min: 0, max: 10000000 });

if (errors.length) return [{ json: { valid: false, errors } }];
return [{ json: { valid: true, errors: [], lead: { name, email, company, title, employees, budget_usd, message } } }];
