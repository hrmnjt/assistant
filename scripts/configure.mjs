import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

// npm run configure                 -> cloudflare/.dev.vars for `npm run dev` (optional)
// npm run configure -- --production -> cloudflare/.prod.vars, uploaded by `npm run secrets`
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const production = process.argv.includes('--production');
const path = production ? 'cloudflare/.prod.vars' : 'cloudflare/.dev.vars';
if (existsSync(path)) {
  console.log(`${path} already exists. Edit it locally; it is never overwritten.`);
} else {
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(
    path,
    [
      // Names and emails are entered in the app at its first sign-in, never here.
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
    production
      ? `Created ${path} with a stable push keypair. Run npm run secrets to upload it. Keep it private.`
      : `Created ${path} with a stable push keypair. Keep it private.`,
  );
}
