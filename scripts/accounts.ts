import 'dotenv/config';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { projectDataDir } from '../server/ai.js';
import { Database } from '../server/database.js';
import { accounts, changePassword, revokeSessions } from '../server/accounts.js';

process.umask(0o077);
const usage = `Usage:
  npm run accounts -- list
  npm run accounts -- password <owner|partner|username>
  npm run accounts -- signout <owner|partner|username|all>`;

/** Read a password without echoing it; piped input supplies one line instead. */
async function secret(prompt: string) {
  if (!stdin.isTTY) {
    const lines = createInterface({ input: stdin });
    for await (const line of lines) {
      lines.close();
      return line;
    }
    return '';
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise<string>((done, fail) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', read);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) fail(error);
      else done(value);
    };
    const read = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003') return finish(new Error('Cancelled; nothing was changed.'));
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on('data', read);
  });
}

const [command, name] = process.argv.slice(2);
const path = resolve(projectDataDir(), 'household.sqlite');
if (!existsSync(path)) {
  console.error('No household database yet. Start the app once to create the two accounts.');
  process.exit(1);
}
const db = new Database(path);
try {
  if (command === 'list') {
    for (const item of accounts(db))
      console.log(
        `${item.id}: ${item.name} (${item.username}), ${item.sessions} signed-in sessions`,
      );
  } else if (command === 'password' && name) {
    const password = await secret('New password (not shown): ');
    if (stdin.isTTY && (await secret('Repeat the new password: ')) !== password)
      throw new Error('The passwords did not match; nothing was changed.');
    const ended = changePassword(db, name, password);
    console.log(`Password changed. Ended ${ended} signed-in sessions for that account.`);
  } else if (command === 'signout' && name) {
    const ended = revokeSessions(db, name === 'all' ? undefined : name);
    console.log(`Ended ${ended} signed-in sessions.`);
  } else {
    console.error(usage);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The account change failed.');
  process.exitCode = 1;
} finally {
  db.close();
}
