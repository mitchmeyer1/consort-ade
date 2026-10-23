import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invokesWarehouse, readOnlyStatement, sameTable, shellWords, tablesReferenced } from '../src/shared/warehouse.ts';

const names = ['snow', 'snowsql', 'hex'];

test('a warehouse CLI is found wherever a command word can start, and not where it is only a name', () => {
  for (const command of ['snowsql -q "select 1"', 'echo hi\nsnow sql -q "select 1"', 'echo `snow sql -q x`', 'x=$(snowsql -q "select 1")', 'snowsql>out', 'cd /tmp && hex run']) assert.ok(invokesWarehouse(command, names), command);
  for (const command of ['curl https://hex.tech/docs', 'grep snowflake notes.md', 'cat snowsql.log']) assert.ok(!invokesWarehouse(command, names), command);
});

test('only one granted command with a read-only -q statement is approved', () => {
  const grant = ['snow', 'snowsql'];
  assert.deepEqual(readOnlyStatement('snowsql -q "select count(*) from analytics.members"', grant), { statement: 'select count(*) from analytics.members' });
  assert.deepEqual(readOnlyStatement("snow sql -q 'with x as (select 1) select * from x'", grant), { statement: 'with x as (select 1) select * from x' });
  const refused = {
    'snowsql -q "delete from t"': /only select/,
    'snowsql -q "select 1" | tee rows.csv': /pipes, redirects/,
    'snowsql -q "select 1" > rows.csv': /pipes, redirects/,
    'snowsql -q "select 1"; rm -rf x': /pipes, redirects/,
    'snowsql -f query.sql': /-q or --query/,
    'env snowsql -q "select 1"': /only snow, snowsql/,
    'printenv': /only snow, snowsql/,
    'snowsql -q "select 1; drop table t"': /names a write/,
    'snowsql -q "select $(id)"': /substitutions/,
    'snowsql -q "select 1': /cannot be parsed/,
  };
  for (const [command, why] of Object.entries(refused)) {
    const r = readOnlyStatement(command, grant);
    assert.ok('problem' in r, command);
    assert.match(r.problem, why, command);
  }
});

test('the tables a statement reads, and names that differ only by a left-off database or schema', () => {
  assert.deepEqual(tablesReferenced('select count(*) from Analytics.Consent.appended_phone p join "ops"."calls" c on c.id = p.id where p.id in (select id from optouts)'), ['analytics.consent.appended_phone', 'ops.calls', 'optouts']);
  assert.ok(sameTable('consent.appended_phone', 'analytics.consent.appended_phone'));
  assert.ok(sameTable('ANALYTICS.CONSENT.APPENDED_PHONE', 'appended_phone'));
  assert.ok(!sameTable('consent.phone', 'analytics.consent.appended_phone'));
});

test('shell words split like a POSIX shell, with operators as their own words', () => {
  assert.deepEqual(shellWords(`a "b c" 'd e' f\\ g h>i j&&k`), ['a', 'b c', 'd e', 'f g', 'h', '>', 'i', 'j', '&&', 'k']);
  assert.equal(shellWords('a "unclosed'), undefined);
});
