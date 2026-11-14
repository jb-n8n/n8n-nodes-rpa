// Which fields hold a credential, judged by their own texts (label, name, id, aria, autocomplete, locator strings).
// Shared by the importers (a value typed there is never imported) and the agent's snapshot (its value is never shown,
// hidesValue).

/**
 * "Password" in the common languages, and its short forms: the one list the importers and the snapshot read, as
 * regular-expression sources matched without case. "pass" counts on its own and inside a name (`#pass`, `user_pass`,
 * `txtPass`), but not in passenger, passport, compass or bypass.
 */
const PASSWORD_WORDS = [
  'password', 'passwd', 'passcode', 'pwd', '(?<!com|by)pass(?!enger|port)', // English
  'passwort', 'kennwort', // German
  'contrase(?:ñ|n)a', // Spanish
  'mot[ _-]?de[ _-]?passe', // French
  "parola d['’]ordine", // Italian (which mostly says "password")
  'senha', // Portuguese
  'wachtwoord', // Dutch
  'l(?:ö|o)senord', // Swedish
  'adgangskode', 'kodeord', // Danish
  'passord', // Norwegian
  'has(?:ł|l)o', // Polish
  'heslo', // Czech
  '(?:ş|s)ifre', // Turkish
  'пароль', // Russian
  'パスワード', // Japanese
  '密码', '密碼', // Chinese
  '비밀번호', // Korean
];
/** A password or PIN field, by its texts: the field a recorded sign-in starts at. */
export const PASSWORD_FIELD = new RegExp(`${PASSWORD_WORDS.join('|')}|\\bpin\\b`, 'i');
/** A field whose selector, label, name, id or aria text says it holds a credential: a password, a PIN or a secret. */
export const CREDENTIAL_FIELD = new RegExp(`${PASSWORD_FIELD.source}|secret`, 'i');
/**
 * A field whose own texts name a one-time code this strictly; "Company Code", "Promo code" or SAP's command field
 * (`ToolbarOkCode`) are not. Matched against each text trimmed.
 */
export const STRICT_TOTP_FIELD = /\b(otp|one[- ]?time|verification|authenticat\w*|2fa|mfa|security code)\b|^code$/i;

/**
 * The agent's snapshot only (the importers keep the rules above): fields that hold a secret without being a sign-in
 * field, whose value the model never sees. No bare "key": SAP's "Key date" is a business field. Any text with "pass"
 * in it, Passenger and Passport too: the snapshot keeps hiding those, as it did before the importers stopped stripping
 * them.
 */
export const SNAPSHOT_CREDENTIAL_FIELD =
  /pass|api[ _-]?key|access[ _-]?key|private[ _-]?key|\btoken\b|\bcvv\b|\bcvc\b|\bcsc\b|card ?number|security (question|answer)|memorable/i;
/** An autocomplete token for payment card data (cc-number, cc-csc, cc-name, cc-exp…), possibly after section tokens. */
export const CARD_AUTOCOMPLETE = /(^|\s)cc-/i;
/** Every pattern the snapshot hides a field's value by, matched against each of its texts (trimmed). */
export const SNAPSHOT_HIDDEN_FIELD = [CREDENTIAL_FIELD, STRICT_TOTP_FIELD, SNAPSHOT_CREDENTIAL_FIELD];

/** Whether the snapshot must hide a field's value: its texts or its autocomplete say it holds a credential or card data. */
export function hidesValue(texts: readonly string[], autocomplete = ''): boolean {
  return CARD_AUTOCOMPLETE.test(autocomplete) || texts.some((t) => SNAPSHOT_HIDDEN_FIELD.some((re) => re.test(t.trim())));
}
