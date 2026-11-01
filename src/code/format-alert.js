// Turn the Error Trigger payload into an alert for the on-call channel.
const e = $input.first().json;
const message = String((e.execution && e.execution.error && e.execution.error.message) || 'unknown error');
const m = message.match(/Event ([A-Za-z0-9_-]{1,64}) failed/);
return [{
  json: {
    severity: 'error',
    workflow: e.workflow ? e.workflow.name : null,
    workflow_id: e.workflow ? e.workflow.id : null,
    execution_id: e.execution ? e.execution.id : null,
    failed_node: e.execution ? e.execution.lastNodeExecuted : null,
    event_id: m ? m[1] : null,
    message: message.slice(0, 500),
    occurred_at: new Date().toISOString(),
  },
}];
