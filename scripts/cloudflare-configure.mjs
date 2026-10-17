import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
if (existsSync('cloudflare/.dev.vars'))
  throw new Error('cloudflare/.dev.vars already exists; edit it directly.');
const keys = webpush.generateVAPIDKeys();
writeFileSync(
  'cloudflare/.dev.vars',
  `APP_ORIGIN=http://localhost:8787\nOWNER_PASSWORD=${randomBytes(24).toString('base64url')}\nPARTNER_PASSWORD=${randomBytes(24).toString('base64url')}\nVAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n# Set PUSH_CONTACT to your real mailto: address to enable phone push.\n`,
  { flag: 'wx', mode: 0o600 },
);
console.log('Created cloudflare/.dev.vars. Read the two passwords there; keep this file private.');
