/** Where a click submits a form: the absolute URL (or the unparsable action as written) and the method. */
export interface FormTarget {
  action: string;
  method: 'GET' | 'POST' | 'DIALOG';
}

/**
 * Runs in the page (page.evaluate, locator.evaluate, or called from another page function whose source is joined with
 * this one): self-contained, no closures over module scope.
 *
 * Where clicking `el` submits its form: the submit control's formaction/formmethod, else its form's action/method. Only
 * a submitting control counts: a submit button (or an element inside one), input[type=submit|image], a label whose
 * control is one of those, or the form itself. Anything else (a link or a field inside the form, a type=button/reset
 * button) gives null. With `withQuery`, a GET target's query is the form's fields, as the browser builds it.
 *
 * Attributes are read through Element.prototype and the document's URLs through their prototype getters, so a page
 * cannot clobber them with a form field named "action", "method", "getAttribute" or an element named "URL" or "baseURI".
 */
export function formTarget(el: Element, withQuery: boolean): FormTarget | null {
  const attr = (e: Element, name: string) => Element.prototype.getAttribute.call(e, name);
  const SUBMITTERS = 'button, input[type=submit], input[type=image]';
  let control = el.closest(SUBMITTERS) as HTMLButtonElement | HTMLInputElement | null;
  // A click on a label activates its control.
  if (!control) {
    const labelled = el.closest('label')?.control;
    if (labelled && labelled.matches(SUBMITTERS)) control = labelled as HTMLButtonElement | HTMLInputElement;
  }
  // The control's own type and form (not clobberable: only a form's and the document's properties are), as the browser
  // reads them: <button type=" button"> is an invalid value, so a submit button.
  if (control && control.type !== 'submit' && control.type !== 'image') return null;
  const form = control ? control.form : el instanceof HTMLFormElement ? el : null;
  if (!form) return null;
  const own = (name: string) => (control !== null ? attr(control, name) : null);
  const actionAttr = own('formaction') ?? attr(form, 'action');
  // An enumerated attribute, matched as the browser does: case-insensitive, untrimmed, anything else is GET.
  const methodAttr = (own('formmethod') ?? attr(form, 'method') ?? '').toLowerCase();
  const method = methodAttr === 'post' ? 'POST' : methodAttr === 'dialog' ? 'DIALOG' : 'GET';
  const documentUrl = (name: 'URL' | 'baseURI') => {
    const owner = name === 'URL' ? Document.prototype : Node.prototype;
    return Object.getOwnPropertyDescriptor(owner, name)?.get?.call(document) as string;
  };
  let url: URL;
  try { url = new URL(actionAttr || documentUrl('URL'), documentUrl('baseURI')); } catch { return { action: actionAttr ?? '', method }; }
  if (withQuery && method === 'GET') {
    const fields: [string, string][] = [];
    new FormData(form, control).forEach((v, k) => { fields.push([k, typeof v === 'string' ? v : v.name]); });
    url.search = new URLSearchParams(fields).toString();
  }
  return { action: url.href, method };
}
