import { describe, expect, it } from 'vitest';
import { createMasker } from '../src/secrets/mask.js';
import { maskSessionSegments, outputUrl, shownUrl, withShownUrls } from '../src/steps/urls.js';

describe('page URLs in output', () => {
  it('drops userinfo and the fragment', () => {
    expect(outputUrl('https://user:pw@example.com/cb#access_token=abc&x=1')).toBe('https://example.com/cb');
    expect(outputUrl('https://example.com/a?q=1#frag')).toBe('https://example.com/a?q=1');
  });
  it('keeps an ordinary query as written', () => {
    expect(outputUrl('https://shop.example/search?q=shoes&page=2')).toBe('https://shop.example/search?q=shoes&page=2');
  });
  it('redacts sensitive parameter values, keeping names and order', () => {
    expect(outputUrl('https://example.com/cb?code=abc&state=x')).toBe('https://example.com/cb?code=[redacted]&state=x');
    expect(outputUrl('https://example.com/?a=1&Access_Token=t&csrf_token=c&SAMLResponse=s&b=2&apiKey=k'))
      .toBe('https://example.com/?a=1&Access_Token=[redacted]&csrf_token=[redacted]&SAMLResponse=[redacted]&b=2&apiKey=[redacted]');
    expect(outputUrl('https://example.com/?sid&password=&state=ok')).toBe('https://example.com/?sid=[redacted]&password=[redacted]&state=ok');
  });
  it('redacts ticket, pwd, pass, otp and code_verifier, and names ending in []', () => {
    expect(outputUrl('https://example.com/?ticket=t&pwd=p&pass=q&otp=1&code_verifier=v&q=ok'))
      .toBe('https://example.com/?ticket=[redacted]&pwd=[redacted]&pass=[redacted]&otp=[redacted]&code_verifier=[redacted]&q=ok');
    expect(outputUrl('https://example.com/?token[]=a&token%5B%5D=b&tags[]=x')).toBe('https://example.com/?token[]=[redacted]&token%5B%5D=[redacted]&tags[]=x');
  });
  it('messages still show origin and path only', () => {
    expect(shownUrl('https://user:pw@example.com/cb?code=abc#t')).toBe('https://example.com/cb');
  });
});

describe('URLs inside messages', () => {
  it('every http(s) URL in a message loses its query string, fragment and userinfo', () => {
    expect(withShownUrls('page.goto: net::ERR_CONNECTION_REFUSED at https://u:p@example.com/a?token=x#f'))
      .toBe('page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/a');
    expect(withShownUrls('from http://a.example/x?q=1 to "http://b.example/y?z=2".')).toBe('from http://a.example/x to "http://b.example/y".');
    expect(withShownUrls('no url here')).toBe('no url here');
  });
  it('cuts at the first ? or # and drops userinfo without re-serialising: no percent-encoding, no punycode', () => {
    expect(withShownUrls('at http://wörd.example/ä?x=1')).toBe('at http://wörd.example/ä');
    expect(withShownUrls('at https://u:p@Host.Example/A%20B#f')).toBe('at https://Host.Example/A%20B');
    expect(withShownUrls('at http://h.example/p@q/r?s')).toBe('at http://h.example/p@q/r');
    // Userinfo ends at the LAST '@' of the authority: a password with '@' in it is dropped whole.
    expect(withShownUrls('https://user:p@ss@host/x?q=1')).toBe('https://host/x');
    expect(withShownUrls('https://u:a@b@c@host/')).toBe('https://host/');
    expect(withShownUrls('https://u:p@ss@host')).toBe('https://host');
    expect(withShownUrls('https://u:p@ss@host\\x@y')).toBe('https://host\\x@y');
    expect(shownUrl('https://user:p@ss@host/x?q=1')).toBe('https://host/x');
    expect(shownUrl('https://u:a@b@c@host:bad/x?q')).toBe('https://host:bad/x'); // not parseable: the text rule applies
    // A secret in the host survives masking around the shortening (re-serialising would have turned it into xn--…).
    const masker = createMasker(['wörd-secret']);
    const out = masker.mask(withShownUrls(masker.mask('see http://wörd-secret.example/x?y=1 and http://h.example/wörd-secret?z')));
    expect(out).toBe('see http://[secret].example/x and http://h.example/[secret]');
    expect(withShownUrls('http://wörd-secret.example/x?y=1')).not.toContain('xn--');
  });
});

describe('maskSessionSegments', () => {
  it('replaces a session-shaped token and leaves other paths alone', () => {
    expect(maskSessionSegments('http://h:1/sap(cz1TSUQ6QU5PTjo=)/bc/gui/sap/its/webgui')).toBe('http://h:1/sap(…)/bc/gui/sap/its/webgui');
    expect(maskSessionSegments('at http://h/sap(abcdefgh12)/x and http://h/sap(abcdefgh12)')).toBe('at http://h/sap(…)/x and http://h/sap(…)');
    expect(maskSessionSegments('/sap(bD1lbiZjPTAwMQ%3d%3d)/bc/gui/sap/its/webgui')).toBe('/sap(…)/bc/gui/sap/its/webgui');
    expect(maskSessionSegments('/sap(abcdefgh);jsessionid=1')).toBe('/sap(…);jsessionid=1');
    for (const same of ['http://h/wiki/Foo_(bar)', 'http://h/odata/Products(1)/Details', 'http://h/acme/home', 'http://h/sap(short)/x', '']) {
      expect(maskSessionSegments(same)).toBe(same);
    }
  });
  it('is applied by the shown and output URL forms', () => {
    expect(shownUrl('http://h/sap(cz1TSUQ6QU5PTjo=)/a?x=1')).toBe('http://h/sap(…)/a');
    expect(outputUrl('http://h/sap(cz1TSUQ6QU5PTjo=)/a?x=1')).toBe('http://h/sap(…)/a?x=1');
    expect(withShownUrls('failed at http://h/sap(cz1TSUQ6QU5PTjo=)/a?x=1')).toBe('failed at http://h/sap(…)/a');
  });
});
