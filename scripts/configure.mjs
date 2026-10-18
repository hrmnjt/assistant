import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

// npm run configure                          -> cloudflare/.dev.vars for `npm run dev`
// npm run configure -- --production <origin> -> cloudflare/.prod.vars for `npm run deploy`
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const production = process.argv.indexOf('--production');
const origin = production >= 0 ? process.argv[production + 1] : 'http://localhost:8787';
if (
  !origin ||
  !/^https?:\/\/[^/]+$/.test(origin) ||
  (production >= 0 && !origin.startsWith('https://'))
)
  throw new Error(
    'Pass the exact app origin, for example --production https://household.example.workers.dev',
  );
const path = production >= 0 ? 'cloudflare/.prod.vars' : 'cloudflare/.dev.vars';
if (existsSync(path)) {
  console.log(`${path} already exists. Edit it locally; it is never overwritten.`);
} else {
  const password = () => randomBytes(24).toString('base64url');
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(
    path,
    [
      `APP_ORIGIN=${origin}`,
      'OWNER_USERNAME=owner',
      'OWNER_NAME=You',
      `OWNER_PASSWORD=${password()}`,
      'PARTNER_USERNAME=partner',
      'PARTNER_NAME=Partner',
      `PARTNER_PASSWORD=${password()}`,
      `VAPID_PUBLIC_KEY=${keys.publicKey}`,
      `VAPID_PRIVATE_KEY=${keys.privateKey}`,
      '# PUSH_CONTACT=mailto:you@example.com',
      '# ICLOUD_USERNAME=',
      '# ICLOUD_APP_PASSWORD=',
      '# ICLOUD_CALENDAR_NAME=Household',
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    `Created ${path} with two generated passwords and a stable push keypair. Open it to set names and read the sign-in details; keep it private.`,
  );
}
