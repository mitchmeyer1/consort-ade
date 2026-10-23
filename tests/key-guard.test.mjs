import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyExposure, protectedPath, searchExposure, KEY_DENY } from '../src/shared/keyGuard.ts';

const where = { cwd: '/Users/me/.consort-cli/worktrees/task', home: '/Users/me', consortHome: '/Users/me/.consort-cli' };
const exposes = (command) => assert.ok(keyExposure(command, where), `expected a denial: ${command}`);
const passes = (command) => assert.equal(keyExposure(command, where), undefined, command);

test('commands that print the environment, aliases or functions are refused', () => {
  for (const command of ['env', 'env | grep KEY', 'env -0', 'env FOO=1', 'printenv', 'printenv HOME', 'export', 'export -p', 'declare -x', 'declare -p FOO', 'set', 'set | less', 'alias', 'type claude', 'which node', 'command -v node', 'whence node', 'typeset', 'functions', 'cd /tmp && env']) exposes(command);
});

test('running under extra variables, setting options and exporting a value stay allowed', () => {
  for (const command of ['env FOO=1 node x.js', 'env -u DEBUG node x.js', 'export FOO=bar', 'set -euo pipefail', 'node --version', 'pnpm test', 'FOO=1 pnpm test']) passes(command);
});

test('a key variable is never expanded, except to test that it is set', () => {
  for (const command of ['echo $ANTHROPIC_API_KEY', 'echo "${OPENAI_API_KEY}"', 'curl -H "x-api-key: $COVERED_ANTHROPIC_API_KEY" http://localhost:1', 'echo ${!ANTHROPIC@}', '[ -n "$OPENAI_API_KEY" ] && echo $OPENAI_API_KEY']) exposes(command);
  for (const command of ['[ -n "$ANTHROPIC_API_KEY" ] && echo set', 'test -z "$OPENAI_API_KEY" || echo present', '[[ -n $SOME_API_KEY ]]']) passes(command);
});

test('the Keychain, startup files, shell snapshots and Consort state are out of reach', () => {
  for (const command of ['security find-generic-password -w -s anthropic-phi-api-key', 'security dump-keychain', 'cat ~/.zshenv', 'source ~/.zshrc', 'grep KEY $HOME/.profile', 'cat /Users/me/.bash_profile', 'echo x >> ~/.zshrc',
    'ls ~/.claude/shell-snapshots/', 'cat ~/.consort-cli/state.json', 'cat ../../state.json', 'ls $CONSORT_CLI_HOME/logins', 'ls ~/.consort-cli', 'cat ~/.consort-cli/*', 'tar czf x.tgz ~/.consort-cli']) exposes(command);
});

test('a recursive read over the home folder is refused; one over the worktree is not', () => {
  for (const command of ['grep -r token ~', 'find / -name "*.pem"', 'rg secret /Users']) exposes(command);
  for (const command of ['grep -r token .', 'find .. -name package.json', 'ls ~/Desktop', 'cat README.md', 'git commit -m "document the member_data export"']) passes(command);
});

test('the reason names what was refused, and the deny text says how to check a tool or a variable instead', () => {
  assert.match(keyExposure('printenv', where), /printenv/);
  assert.match(keyExposure('cat ~/.zshenv', where), /\.zshenv is a shell startup file/);
  assert.match(KEY_DENY('it reads the Keychain'), /Not run: it reads the Keychain\..*--version.*\[ -n "\$NAME" \]/);
});

test('a runner, a full path or a shell string changes nothing', () => {
  for (const command of ['command env', 'sh -c env', 'bash -lc "printenv HOME"', '/usr/bin/env', '/usr/bin/printenv', 'nohup env', 'exec env', 'xargs -0 printenv', 'timeout 5 env', 'eval printenv', 'security -q find-generic-password -s anthropic-phi-api-key -w', '/usr/bin/security find-generic-password -s x', 'n=CLAUDE_CODE_OAUTH_TOKEN; echo ${!n}']) exposes(command);
  for (const command of ['sh -c "pnpm test"', 'timeout 60 pnpm test', 'xargs -n1 echo', 'git push 2>&1 | tail -5', '/usr/bin/git status']) passes(command);
});

test('a glob or a brace pattern is read for every name it could match', () => {
  for (const command of ['cat ~/.zsh*', 'cat ~/.zsh{env,rc}', 'cat $HOME/.[bz]sh*', 'ls ~/.consort-cli/*', 'cat ~/.c*/state.json', 'ls ~/.claude/shell-*', 'cat /Users/*/.zshenv']) exposes(command);
  for (const command of ['ls ~/*', 'cat ~/*.txt', 'ls src/*.ts', 'cat {a,b}.md']) passes(command);
});

test('a search over a folder that holds the startup files or Consort state is refused; one over the worktree is not', () => {
  for (const path of ['~', '/Users/me', '/Users', '/Users/me/.consort-cli']) assert.ok(searchExposure(path, where), path);
  for (const path of ['.', 'src', '/Users/me/.consort-cli/worktrees/task']) assert.equal(searchExposure(path, where), undefined, path);
});

test('file tools: key paths and files named as member data are protected', () => {
  for (const path of ['~/.zshenv', '/Users/me/.consort-cli/secrets/covered-key', '/Users/me/.consort-cli/logins/a/creds.json', 'exports/member_data.csv', 'phi-export.json', '/tmp/patient_records.xlsx']) assert.ok(protectedPath(path, where), path);
  for (const path of ['src/members.ts', 'README.md', '/Users/me/.consort-cli/worktrees/task/src/a.ts']) assert.equal(protectedPath(path, where), undefined, path);
});
