#!/usr/bin/env node
/**
 * Generate a FIELD_ENCRYPTION_KEY.
 *
 * 32 bytes from the platform CSPRNG, base64url encoded — the format
 * src/crypto/field-encryption.ts expects. Printed once, never written to disk.
 */

const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);

let binary = '';
for (const b of bytes) binary += String.fromCharCode(b);
const key = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log(`\n${key}\n`);
console.log('Store it as a secret — never in wrangler.jsonc, never in git:\n');
console.log('  wrangler secret put FIELD_ENCRYPTION_KEY\n');
console.log('For local dev, put it in .dev.vars (gitignored):\n');
console.log(`  FIELD_ENCRYPTION_KEY="${key}"\n`);
console.log('Rotating this key makes every stored Plaid access token undecryptable.');
console.log('Re-linking each institution is the recovery path.\n');
