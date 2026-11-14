// Template: 2-data-feed.json
// Node: Alert on failure
// Parameter: text
//
// The failure alert email: the error code, the bot, the steps version and lane, the message, the execution and where
// the errors are explained.

={{ $json.details?.code || 'config_error' }} on {{ $('Settings').item.json.name }} (steps v{{ $json.details?.version ?? 'none' }}, {{ $json.details?.lane ?? 'n/a' }} lane)

{{ $json.message ?? $json.error }}
Execution: {{ $execution.id }}

What to do: see docs/reference/errors.md in the n8n-nodes-rpa repository.
