import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../../src/http/security-headers';
import indexHtml from '../../web/index.html?raw';

/**
 * The inline theme-bootstrap script is allowed by SHA-256 hash rather than by
 * 'unsafe-inline'. That keeps script-src strict, but couples two files: if the
 * script in web/index.html is edited and the hash in security-headers.ts is
 * not, the browser silently refuses to run it and every dark-pole user gets a
 * white flash again — with no error anyone would notice in review.
 *
 * This test re-computes the hash from the real file and asserts the CSP still
 * lists it, so the drift is caught at test time rather than in production.
 */
async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe('CSP and the inline theme bootstrap', () => {
  it('has exactly one inline script in the shell', () => {
    const inline = indexHtml.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
    // Every additional inline script would need its own hash. Keeping this at
    // one is the thing that makes the coupling manageable.
    expect(inline).toHaveLength(1);
  });

  it('lists the current hash of that script in script-src', async () => {
    const match = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).toBeTruthy();

    const hash = `'sha256-${await sha256Base64(match![1])}'`;
    const csp = securityHeaders({ includeHsts: true })['Content-Security-Policy'];

    expect(
      csp.includes(hash),
      `The inline theme-bootstrap script in web/index.html does not match the ` +
        `hash in src/http/security-headers.ts.\nExpected script-src to contain: ${hash}`,
    ).toBe(true);
  });

  it('keeps script-src otherwise strict', () => {
    const csp = securityHeaders({ includeHsts: true })['Content-Security-Policy'];
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('does not allow inline styles either', () => {
    // CSP governs <style> blocks and style attributes — NOT the CSSOM writes
    // the components actually use. Nothing in the shell needs the concession.
    const csp = securityHeaders({ includeHsts: true })['Content-Security-Policy'];
    const styleSrc = csp.split(';').find((d) => d.trim().startsWith('style-src')) ?? '';
    expect(styleSrc).not.toContain("'unsafe-inline'");
  });

  it('does not ship a hardcoded data-theme that defeats the bootstrap', () => {
    // A hardcoded data-theme on <html> is what forced every dark-pole user
    // through a light flash in the first place.
    expect(indexHtml).not.toMatch(/<html[^>]*data-theme=/);
  });

  it('runs the bootstrap before the stylesheet', () => {
    // After the stylesheet, the first paint has already happened with the
    // wrong tokens.
    const scriptAt = indexHtml.indexOf('<script>');
    const styleAt = indexHtml.indexOf('rel="stylesheet"');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(styleAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeLessThan(styleAt);
  });
});
