// The uncovered turn's warehouse guard: the organisation's query guard matrix (pii-guard's
// test_query_guard.py) on the port, then the write and hidden-statement checks Consort adds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exposesIdentifiers, hidesStatement, warehouseProblem, writesWarehouse, HIDDEN_DENY, QUERY_DENY, WRITE_DENY } from '../src/shared/warehouse.ts';

const query = (sql) => `snowsql -q "${sql}"`;
const denied = (command, extra) => assert.equal(exposesIdentifiers(command, extra), true, command);
const permitted = (command, extra) => assert.equal(exposesIdentifiers(command, extra), false, command);

test('a projected identifier column is denied; an aggregate over the same table is not', () => {
  denied(query('select first_name from prod.members where 1=0'));
  denied('snow sql -q "select first_name from prod.members where 1=0"');
  permitted('snow sql -q "select count(*) from prod.members"');
  denied(query('select * from prod.members'));
  permitted(query('select count(*) from prod.members'));
  permitted(query('select * from prod.employers'));
});

test('a catalogue query names an identifier in a predicate; a projection cannot hide behind one', () => {
  permitted(query("select column_name from prod.information_schema.columns where column_name = 'ssn'"));
  denied(query("select ssn from prod.members where exists (select 1 from prod.information_schema.columns where column_name = 'ssn')"));
});

test('modifiers before a wildcard and a front end carrying prose are still caught', () => {
  denied(query('select distinct * from prod.members'));
  denied(query('select top 100 * from prod.members'));
  denied('hex thread create "list first_name and last_name for each member"');
  denied('hex thread create "count the members where first_name is null"');
});

test('rung 2: counts and predicates over identifier columns pass', () => {
  permitted(query('select relationship, count(*) as rows_, count_if(ssn is null) as null_ssn, round(100*count_if(ssn is null)/count(*),1) as pct_null from prod.plan_members group by 1 order by 2 desc'));
  permitted(query('select count(distinct extract(year from dob)) from prod.plan_members'));
  permitted(query('select approx_count_distinct(right(ssn, 4)) from prod.m'));
  permitted(query('select employer, count(*) from prod.m where ssn is null group by 1'));
  permitted(query('select employer from prod.m group by 1 having count_if(dob is null) > 0'));
  permitted(query('select count(*) from prod.a join prod.b on a.ssn = b.ssn and a.dob = b.dob'));
  permitted(query('select count(*) from prod.a join prod.b using (ssn)'));
  permitted(query('select count(*) from prod.a where exists (select 1 from prod.b where b.ssn = a.ssn)'));
  permitted(query('select employer, count(*) from prod.m qualify row_number() over (partition by ssn order by dob desc) = 1 group by 1'));
  permitted(query('select count_if(ssn is null) from prod.m;') + ' snowsql -q "select count(*) from prod.m where dob is null"');
  permitted(query('select 100*count_if(ssn is null)/count(*) from prod.m'));
});

test('a CASE condition passes; its result does not', () => {
  permitted(query("select case when dob >= dateadd(year,-1,current_date) then 'under 1' when dob >= dateadd(year,-5,current_date) then '1-4' else '5+' end as band, count(*) from prod.plan_members where relationship='Dependent' and ssn is null group by 1"));
  denied(query('select case when x = 1 then dob end from prod.m'));
  denied(query('select case when x = 1 then 1 else ssn end from prod.m'));
  denied(query("select case dob when 'unknown' then 1 end from prod.m"));
});

test('values leave through value aggregates, per-row expressions, CTEs and subqueries', () => {
  for (const sql of ['select min(dob) from prod.m', 'select max(ssn) from prod.m', 'select any_value(first_name) from prod.m group by employer', "select listagg(last_name, ',') from prod.m",
    'select right(ssn, 4) from prod.m', 'select iff(ssn is null, 1, 0) from prod.m', 'select extract(year from dob) from prod.m', 'select hash(ssn) from prod.m',
    'with x as (select ssn as s from prod.m) select s from x', 'select count(*) from prod.a where k in (select ssn from prod.b)', 'select (select dob from prod.m limit 1) as d',
    'select ssn_valid from prod.m', 'select emp_ssn, dob_raw from prod.m']) denied(query(sql));
  permitted(query('select count_if(ssn_valid is null) from prod.m'));
});

test('a wildcard beside an identifier or over a person table is unbounded; count(*) is not', () => {
  denied(query('select * from prod.employers where ssn is null'));
  denied(query('select m.* from prod.employers m where dob is null'));
  denied(query('select object_construct(*) from prod.x where ssn is null'));
  denied(query('select object_construct_keep_null(m.*) from prod.plan_members m'));
  denied(query('select * from prod.core.plan_members'));
  permitted(query('select count( * ) from prod.plan_members where ssn is null'));
  permitted(query('select * from prod.core.plan_reference'));
});

test('the added baselines and settings extend the lists; a setting cannot empty them', () => {
  denied(query('select middle_name from prod.x'));
  denied(query('select * from prod.enrollees'));
  denied(query('select policy_holder_alias from prod.enrollment'), { columns: ['policy_holder_alias'] });
  denied(query('select * from prod.roster'), { tables: ['roster'] });
  denied(query('select first_name from prod.members'), { columns: [], tables: [] });
});

test('a single-quoted statement is read as SQL, so rung 2 passes and projections are still caught', () => {
  permitted("snowsql -q 'select count_if(ssn is null) from prod.m'");
  denied("snowsql -q 'select ssn from prod.m'");
  denied("snowsql -q 'select * from prod.members'");
});

test('writes are refused where a statement starts; the same words elsewhere are names', () => {
  for (const command of [query('insert into prod.m values (1)'), query('select 1; drop table prod.m'), "snowsql -q 'delete from prod.m'", 'snowsql <<SQL\nupdate prod.m set x = 1\nSQL', 'snow stage copy ./rows.csv @stage', 'snow object drop table prod.m', query('create or replace table prod.x as select 1')]) assert.equal(writesWarehouse(command), true, command);
  for (const command of [query("select count(*) from prod.m where status = 'update'"), query("select count(*) from prod.m where status = 'delete pending'"), 'snow sql -q "select 1"', 'snow object list table', 'hex thread create "how many rows were created last month?"']) assert.equal(writesWarehouse(command), false, command);
});

test('comments are read as what runs: inside the SQL they are a space, outside it nothing is removed', () => {
  denied('snow sql -q "select /* where */ ssn from members"');
  denied('snow sql -q "select/**/* from members"');
  denied('snowsql -q "select -- where\n ssn from members"');
  denied('snowsql <<SQL\nselect /* where */ first_name from members\nSQL');
  denied('snowsql --query "select ssn from members"');
  permitted('snowsql -q "select count_if(ssn is null) /* rung 2 */ from members -- a count"');
  assert.equal(writesWarehouse('snow sql -q "select 1; /**/ delete from members"'), true);
});

test('a keyword inside a group that closed before the mention is not its clause', () => {
  denied(query('select row_number() over (order by id) rn, ssn from members'));
  denied(query('select count(*) over (partition by employer), first_name from members'));
  permitted(query('select employer, count(*) from prod.m qualify row_number() over (partition by ssn order by dob desc) = 1 group by 1'));
});

test('a statement the guard cannot read: a file, piped or redirected input, a variable or a substitution', () => {
  const names = ['snow', 'snowsql', 'hex'];
  for (const command of ['snowsql -f query.sql', 'snow sql --filename=query.sql', 'snowsql < query.sql', 'cat q.sql | snow sql --stdin', 'cat q.sql | snowsql', 'snow sql -q "$(cat q.sql)"', 'snowsql -q $(cat q.sql)', 'snowsql -q "select $COLUMN from m"', 'snowsql <<SQL\nselect `cat c` from m\nSQL', 'snowsql -q "unclosed']) assert.equal(hidesStatement(command, names), true, command);
  for (const command of ['snowsql <<SQL\nselect $1 from @stage\nSQL', query('select 1'), 'n=$(snowsql -q "select count(*) from m")', 'snowsql -q "select count(*) from m" | head -5']) assert.equal(hidesStatement(command, names), false, command);
});

test('warehouseProblem checks hidden statements, then writes, then identifiers', () => {
  const names = ['snow', 'snowsql', 'hex'];
  assert.equal(warehouseProblem('snowsql -f q.sql', { names }), HIDDEN_DENY);
  assert.equal(warehouseProblem(query('delete from prod.m where ssn is null'), { names }), WRITE_DENY);
  assert.equal(warehouseProblem(query('select ssn from prod.m'), { names }), QUERY_DENY);
  assert.equal(warehouseProblem(query('select count(*) from prod.m'), { names }), undefined);
  assert.match(QUERY_DENY, /\[covered-analyst: …\]/);
});
