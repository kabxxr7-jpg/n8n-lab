// The digest covers the last 24 hours.
const WINDOW_HOURS = 24;
const until = new Date();
const since = new Date(until.getTime() - WINDOW_HOURS * 3600 * 1000);
return [{ json: { since: since.toISOString(), until: until.toISOString(), window_hours: WINDOW_HOURS } }];
