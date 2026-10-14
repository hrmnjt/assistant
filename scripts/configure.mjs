import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (existsSync('.env')) {
  console.log('.env already exists. Edit it locally; existing accounts are preserved in data/.');
} else {
  const password = () => randomBytes(24).toString('base64url');
  writeFileSync(
    '.env',
    `PORT=3000\nAPP_ORIGIN=http://localhost:5173\nDATA_DIR=./data\nOWNER_USERNAME=owner\nOWNER_NAME=You\nOWNER_PASSWORD=${password()}\nPARTNER_USERNAME=partner\nPARTNER_NAME=Partner\nPARTNER_PASSWORD=${password()}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Created .env inside this repository with two generated passwords. Open it locally to set names and retrieve the sign-in details.',
  );
}
