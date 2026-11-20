// Template: 2-data-feed.json
// Node: Alert on failure
// Parameter: text
//
// The failure alert email: the error code, the bot, the steps version and lane, the message, which version waits for
// approval and how to approve it (REPAIR_WAITING), what to do, the execution and where the errors are explained.

={{ $json.details?.code || 'config_error' }} on {{ $('Settings').item.json.name }} (steps v{{ $json.details?.version ?? 'none' }}, {{ $json.details?.lane ?? 'n/a' }} lane)

{{ $json.message ?? $json.error }}{{
  ((w) => (w ? '\n' + w : ''))(REPAIR_WAITING)
}}
What to do: {{
  $json.details?.guidance || 'see docs/reference/errors.md in the n8n-nodes-rpa repository.'
}}
Execution: {{ $execution.id }}

The error codes are explained in docs/reference/errors.md in the n8n-nodes-rpa repository.
