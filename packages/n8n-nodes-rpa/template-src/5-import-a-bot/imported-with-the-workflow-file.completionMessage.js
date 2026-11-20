// Template: 5-import-a-bot.json
// Node: Imported, with the workflow file
// Parameter: completionMessage
//
// The last page when the import also made a workflow file: what was imported, the outcome of the review, the file the
// browser downloads, and the secrets to put in a credential. IMPORTED_COUNTS, IMPORTED_RESULT and IMPORTED_SECRETS are
// in snippets.js, shared with the Imported page.

=Imported: {{ IMPORTED_COUNTS }}
{{ IMPORTED_RESULT }}
Your browser downloads {{ (ESCAPE_HTML)($('Import steps').first(0).binary.workflow.fileName) }}: {{
  (
    (r) => (
      r.source === 'uipath'
        ? 'the rest of the bot as an n8n workflow. Open it in n8n with ⋯ → Import → From File'
          + (
            r.items.some((i) => i.kind === 'untranslated')
              ? '; grey notes in it mark what was not translated.'
              : '.'
          )
        : 'the workflow that runs the bot. Open it in n8n with ⋯ → Import → From File.'
    )
  )($('Import steps').first(0).json.report)
}}{{ IMPORTED_SECRETS }}
