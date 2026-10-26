// Which fields hold a credential, judged by their own texts (label, name, id, aria, autocomplete, locator strings).
// Shared by the importer (a value typed there is never imported) and the agent's snapshot (its value is never shown,
// hidesValue).

/** A field whose selector, label, name, id or aria text says it holds a credential. */
export const CREDENTIAL_FIELD = /pass(word|wd|code)?|pwd|\bpin\b|secret/i;
/**
 * A field whose own texts name a one-time code this strictly; "Company Code", "Promo code" or SAP's command field
 * (`ToolbarOkCode`) are not. Matched against each text trimmed.
 */
export const STRICT_TOTP_FIELD = /\b(otp|one[- ]?time|verification|authenticat\w*|2fa|mfa|security code)\b|^code$/i;

/**
 * The agent's snapshot only (the importer keeps the rules above): fields that hold a secret without being a sign-in
 * field, whose value the model never sees. No bare "key": SAP's "Key date" is a business field.
 */
export const SNAPSHOT_CREDENTIAL_FIELD =
  /api[ _-]?key|access[ _-]?key|private[ _-]?key|\btoken\b|\bcvv\b|\bcvc\b|\bcsc\b|card ?number|security (question|answer)|memorable/i;
/** An autocomplete token for payment card data (cc-number, cc-csc, cc-name, cc-exp…), possibly after section tokens. */
export const CARD_AUTOCOMPLETE = /(^|\s)cc-/i;
/** Every pattern the snapshot hides a field's value by, matched against each of its texts (trimmed). */
export const SNAPSHOT_HIDDEN_FIELD = [CREDENTIAL_FIELD, STRICT_TOTP_FIELD, SNAPSHOT_CREDENTIAL_FIELD];

/** Whether the snapshot must hide a field's value: its texts or its autocomplete say it holds a credential or card data. */
export function hidesValue(texts: readonly string[], autocomplete = ''): boolean {
  return CARD_AUTOCOMPLETE.test(autocomplete) || texts.some((t) => SNAPSHOT_HIDDEN_FIELD.some((re) => re.test(t.trim())));
}
