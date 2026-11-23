const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = readFileSync(__dirname + '/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// Minimal document surface executes the entire standalone script, including all renderers.
function element() {
  return { innerHTML: '', textContent: '', dataset: {}, style: {}, scrollTop: 0, offsetTop: 0, offsetHeight: 20, offsetWidth: 1200, clientHeight: 900, clientWidth: 1400,
    classList: { toggle() {}, add() {} }, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, height: 20 }),
    querySelector: () => null, querySelectorAll: () => [], closest: () => element(), parentElement: { clientWidth: 1400 } };
}
const elements = new Map();
const context = vm.createContext({ console, setInterval, clearInterval, location: { hash: '#tab=dash' },
  window: { addEventListener() {} }, document: { body: element(), addEventListener() {},
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelectorAll(q) { return q === '#code .l' ? Array.from({ length: 53 }, element) : []; }, querySelector() { return null; } } });
vm.runInContext(script, context);
const run = code => vm.runInContext(code, context);
const data = code => JSON.parse(JSON.stringify(run(code)));
assert.deepEqual(data('SEED.employers.map(e=>e.name)'), ['TikTok', 'ByteDance', 'Fifth Third', 'iHeartMedia']);
assert.equal(run('SEED.planRows.length'), 10);
assert.equal(run('SEED.members.length'), 11);
const amounts = Object.fromEntries(data('DB.invoices.map(i=>[i.member.id,i.total])'));
assert.deepEqual(amounts, { 101: 1000, 102: 2000, 103: 2000, 104: 1000, 105: 2000, 107: 1500, 109: 2000, 110: 2000 });
const decision = id => data(`BILLING.find(x=>x.v.id===${JSON.stringify(id)})`);
for (const id of ['demo_v_101_annual', 'demo_v_101_virtual', 'demo_v_101_ffs', 'demo_v_108_capped', 'demo_v_109_primary', 'demo_v_109_sick', 'demo_v_110_pending']) assert.equal(decision(id).amount, 0, id);
for (const id of ['demo_v_102_unknown', 'demo_v_103_boundary', 'demo_v_106_after', 'demo_v_111_missing', 'demo_v_110_unknown_tag']) assert.equal(decision(id).held, true, id);
assert.equal(decision('demo_v_107_virtual').amount, 500, 'OOP boundary clips to $5');
assert.equal(decision('demo_v_107_capped').amount, 0, 'later visit cannot exceed OOP maximum');
assert.equal(decision('demo_v_103_after').held, true, 'deductible boundary remains held');
assert.equal(run('priceVisits([demoVisit(101,"early",40,"sick",1,{date:"2026-12-31"})])[0].amount'), 0);
assert.equal(run('priceVisits([...SEED.visits].reverse()).reduce((s,x)=>s+x.amount,0)'), 13500, 'chronological cap evaluation');
assert.equal(run('TRACE.at(-1).invoices.length'), 8);
for (const i of data('DB.invoices')) {
  const trace = data('TRACE.at(-1).invoices').find(x => x.includes(`member_id: ${i.member.id},`));
  assert.ok(trace.includes(`total_cents: ${i.total},`), 'player total matches dashboard');
  for (const item of i.items) assert.ok(trace.includes(`visit_id: "${item.v.id}"`));
}
for (const route of ['employers', 'groups', 'buckets', 'visits', ...data('SEED.employers.map(e=>`employers/${e.id}`)'), ...data('SEED.planRows.map(p=>`employers/${p.employer_id}/plans/${p.id}`)'), ...data('DB.groups.map(g=>`groups/${g.id}`)'), ...data('SEED.buckets.map(b=>`buckets/${b.id}`)'), ...data('SEED.visits.map(v=>`visits/${v.id}`)')]) {
  const result = data(`dashView(${JSON.stringify(route.split('/'))})`);
  assert.ok(result.html.includes('<h2>'), route);
  assert.ok(!result.html.includes('undefined'), route);
}
const virtualBucket = run('dashView(["buckets","2"]).html');
assert.ok(virtualBucket.includes('ByteDance') && virtualBucket.includes('Fifth Third') && virtualBucket.includes('iHeartMedia'));
assert.ok(elements.get('seed-tables').innerHTML.includes('demo_v_109_chat'));
assert.ok(!/Acme|Gold|Silver|Riverbend|September 2026/.test(html));
console.log('PASS: 4 employers, 10 plans, 11 fictional members, 25 visits; 8 invoices total $135.00.');
console.log('PASS: prices, exclusions, deductible holds, missing balances, OOP cap, period, trace totals, and every dashboard route.');
