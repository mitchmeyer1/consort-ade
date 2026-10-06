import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubLogin, topContributor } from '../src/shared/contributors.ts';

const commit = (name, email) => ({ name, email });

test('a GitHub noreply address carries the login', () => {
  assert.equal(githubLogin('12345+mitchmeyer@users.noreply.github.com'), 'mitchmeyer');
  assert.equal(githubLogin('octocat@users.noreply.github.com'), 'octocat');
  assert.equal(githubLogin(' 99+Someone@Users.NoReply.GitHub.com '), 'Someone');
});

test('an ordinary address has no login in it', () => {
  for (const email of ['someone@example.com', 'me@users.noreply.example.com', '']) assert.equal(githubLogin(email), undefined);
});

test('the author with the most commits wins', () => {
  const top = topContributor([
    commit('Mitch Meyer', '1+mitchmeyer@users.noreply.github.com'),
    commit('Ada L', 'ada@example.com'),
    commit('Mitch Meyer', '1+mitchmeyer@users.noreply.github.com'),
  ]);
  assert.equal(top.login, 'mitchmeyer');
  assert.equal(top.commits, 2);
});

test('one person committing under two names counts once', () => {
  const top = topContributor([
    commit('ada', '9+ada@users.noreply.github.com'),
    commit('Ada Lovelace', '9+ada@users.noreply.github.com'),
    commit('Someone Else', 'else@example.com'),
  ]);
  assert.equal(top.login, 'ada');
  assert.equal(top.commits, 2);
});

test('without a login the person is still named, by email identity', () => {
  const top = topContributor([commit('Ada Lovelace', 'ada@example.com'), commit('Ada Lovelace', 'ada@example.com')]);
  assert.equal(top.login, undefined);
  assert.equal(top.name, 'Ada Lovelace');
  assert.equal(top.commits, 2);
});

test('a tie keeps the most recent author, and no commits means nobody', () => {
  const top = topContributor([commit('Newest', 'new@example.com'), commit('Older', 'old@example.com')]);
  assert.equal(top.name, 'Newest');
  assert.equal(topContributor([]), undefined);
});
