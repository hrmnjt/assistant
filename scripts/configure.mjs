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
      ...(production
        ? [
            '# From Cloudflare Access: the team domain and the application audience (AUD) tag.',
            'ACCESS_TEAM_DOMAIN=',
            'ACCESS_AUD=',
          ]
        : ['# No sign-in: development serves only this computer. Leave out ACCESS_* here.']),
      'OWNER_NAME=You',
      ...(production ? ['OWNER_EMAIL='] : []),
      'PARTNER_NAME=Partner',
      ...(production ? ['PARTNER_EMAIL='] : []),
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
      ? `Created ${path} with a stable push keypair. Add the Cloudflare Access settings and the two email addresses, then run npm run secrets. Keep it private.`
      : `Created ${path} with names and a stable push keypair. Keep it private.`,
  );
}
