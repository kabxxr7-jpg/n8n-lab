// Sign the outbound request: HMAC-SHA256 over "<unix seconds>.<exact body string>".
// The same body string is sent as the raw request body, so the bytes match.
const crypto = require('crypto');
const { event } = $input.first().json;
const secret = $env.LAB_SIGNING_SECRET;
if (!secret) throw new Error('LAB_SIGNING_SECRET is not set');

const bodyString = JSON.stringify({ event_id: event.event_id, text: event.text });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature =
  'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${bodyString}`).digest('hex');

return [{ json: { event, bodyString, timestamp, signature } }];
