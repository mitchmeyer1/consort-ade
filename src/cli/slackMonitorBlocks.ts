/**
 * The master monitor as native Slack Block Kit. Slack text stays sharp at any width and in either
 * theme, links are clickable, and nothing is uploaded. Built from the monitor text (shared/slackMonitor.ts)
 * after the PHI guard has run, so a guard replacement never reaches a block as task content.
 */
const LIMIT = 2900;
const MAX_BLOCKS = 50;
type Row = { icon: string; kind: string; title: string; thread?: string; pending: boolean; byline?: string; status: string; stage?: { name: string; n: number; total: number }; cost?: string; age?: string; action?: string; links: string[] };
type Group = { key: 'reply' | 'ready' | 'working' | 'completed'; icon: string; heading: string; empty: string; rows: Row[]; notes: string[] };

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, LIMIT) } });
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: text.slice(0, LIMIT) }] });
const divider = () => ({ type: 'divider' });
const link = (url: string | undefined, label: string) => (url ? `<${url}|${label}>` : label);
/** `▰▰▱▱▱`: stages done out of the total, in text that every Slack client renders. */
export const bar = (done: number, total: number) => (total > 0 && total <= 30 ? '▰'.repeat(Math.max(0, Math.min(done, total))) + '▱'.repeat(Math.max(0, total - done)) : '');

/** Split on ' · ' without breaking a `<url|label>` whose label contains the separator. */
function parts(line: string): string[] {
  const tokens: string[] = [];
  const masked = line.replace(/<https:\/\/[^>]+>/g, m => { tokens.push(m); return `\u0000${tokens.length - 1}\u0000`; });
  return masked.split(' · ').map(p => p.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]).trim());
}
function parseRow(line: string, details: string[]): Row {
  const p = parts(line);
  const [icon, ...kindWords] = p[0].split(' ');
  const titleRaw = p[1] ?? '';
  const pending = / \(Slack thread pending\)$/.test(titleRaw);
  const linked = titleRaw.replace(/ \(Slack thread pending\)$/, '').match(/^<(https:\/\/[^|>]+)\|(.+)>$/);
  const row: Row = { icon, kind: kindWords.join(' '), title: linked ? linked[2] : titleRaw.replace(/ \(Slack thread pending\)$/, ''), thread: linked?.[1], pending, status: '', links: [] };
  const stageOf = (s: string) => { const m = s.match(/^(.*?)\s*(\d+)\/(\d+)$/); return m ? { name: m[1], n: Number(m[2]), total: Number(m[3]) } : undefined; };
  if (p.length >= 7) { row.byline = p[2]; row.status = p[3]; row.stage = stageOf(p[4]); row.cost = p[5]; row.age = p.slice(6).join(' · '); }
  else { row.status = p[2] ?? ''; row.stage = stageOf(p[3] ?? ''); }
  for (const d of details) {
    if (/<https:\/\/[^|>]+\|(?:ticket|github|merge PR)>/.test(d)) row.links.push(...d.split(' · ').map(l => l.replace(/\|ticket>/, '|ClickUp>').replace(/\|github>/, '|GitHub>').replace(/\|merge PR>/, '|Merge PR>')));
    else row.action = row.action ? `${row.action} ${d}` : d;
  }
  return row;
}
/** A row shows its own icon only when it differs from the group's (a stopped task under Working). */
function taskText(row: Row, group: Group): string {
  const compact = group.key === 'completed';
  const title = `${row.icon === group.icon ? '' : row.icon + ' '}*${link(row.thread, row.title)}*`;
  const by = row.byline?.replace(/^author: /, 'by ');
  const status = ['RUNNING', 'WAITING', 'READY TO MERGE', 'DONE', ''].includes(row.status) ? undefined : `*${row.status}*`;
  if (compact) return [title, status, by, row.cost, row.age, ...row.links].filter(Boolean).join(' · ');
  const lines = [title];
  const progress = row.stage ? `${row.stage.name} ${row.stage.n}/${row.stage.total} ${bar(row.icon === '📦' ? row.stage.n : row.stage.n - 1, row.stage.total)}`.trim() : undefined;
  lines.push([progress, status, row.kind, by, row.cost, row.age].filter(Boolean).join(' · '));
  if (row.action) lines.push(`> ${row.action}`);
  const links = [row.thread ? link(row.thread, 'Thread') : row.pending ? '_thread pending_' : '', ...row.links].filter(Boolean);
  if (links.length) lines.push(links.join('  ·  '));
  return lines.join('\n');
}
/** Rows packed into as few sections as fit, so 40 tasks stay well inside Slack's 50-block limit. */
function packed(texts: string[]): ReturnType<typeof section>[] {
  const out: ReturnType<typeof section>[] = []; let chunk = '';
  for (const t of texts) {
    const text = t.length > LIMIT ? t.slice(0, LIMIT - 1) + '…' : t;
    if (chunk && chunk.length + text.length + 2 > LIMIT) { out.push(section(chunk)); chunk = ''; }
    chunk += (chunk ? '\n\n' : '') + text;
  }
  if (chunk) out.push(section(chunk));
  return out;
}
function accountText(line: string): string {
  const p = parts(line); const [icon, ...name] = p[0].split(' ');
  const rest = p.slice(1);
  if (icon === '🔴') return `${icon} *${name.join(' ')}*  ·  ${rest.join(' · ')}`;
  const percents = rest.flatMap(r => [...r.matchAll(/(\d+)%/g)].map(m => Number(m[1])));
  const peak = percents.length ? Math.max(...percents) : undefined;
  if (peak === undefined) return `${icon} *${name.join(' ')}*  ·  ${rest.join(' · ')}`;
  return `${icon} *${name.join(' ')}*  ${bar(Math.round(Math.min(100, peak) / 10), 10)} ${peak}%  ·  ${rest.filter(r => !/^(available|usage unavailable)$/.test(r)).join(' · ')}`;
}

/** Blocks for a master monitor text; undefined for anything else (guard notices, legacy posts, tests). */
export function monitorBlockKit(safe: string): unknown[] | undefined {
  const lines = safe.split('\n');
  if (!lines[0].startsWith('*📊 Consort master monitor*') || !lines.includes('*Working*')) return undefined;
  const groups: Record<Group['key'], Group> = {
    reply: { key: 'reply', icon: '🟠', heading: '🟠 *Needs your reply*', empty: 'Nothing needs your reply.', rows: [], notes: [] },
    ready: { key: 'ready', icon: '📦', heading: '📦 *Ready to merge*', empty: 'Nothing waiting to be merged.', rows: [], notes: [] },
    working: { key: 'working', icon: '🔄', heading: '🔄 *Working*', empty: 'No tasks in progress.', rows: [], notes: [] },
    completed: { key: 'completed', icon: '🎉🍭🎊', heading: '✅ *Completed*', empty: 'No completed tasks yet.', rows: [], notes: [] },
  };
  const accounts: string[] = [];
  let sectionName = '';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^\*([^*]+)\*$/);
    if (heading) { sectionName = heading[1]; continue; }
    if (!line || line === 'STATUS: MONITORING' || line.startsWith('Updated ') || line.startsWith('Open a ticket title') || line.startsWith('No ')) continue;
    if (sectionName === 'Accounts') { accounts.push(line); continue; }
    const group: Group | undefined = sectionName.startsWith('Working') ? groups.working : sectionName.startsWith('Ready') ? groups.ready : sectionName.startsWith('Completed') ? groups.completed : undefined;
    if (!group) continue;
    if (line.startsWith('… ')) { group.notes.push(line); continue; }
    const details: string[] = [];
    while (lines[i + 1]?.startsWith('   ')) details.push(lines[++i].trim());
    const row = parseRow(line, details);
    (group.key === 'working' && row.icon === '🟠' ? groups.reply : group).rows.push(row);
  }
  const updated = lines[1]?.match(/^Updated (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/);
  const stamp = updated ? `<!date^${Math.floor(Date.parse(`${updated[1]}T${updated[2]}:00Z`) / 1000)}^{date_short_pretty} {time}|${lines[1]}>` : lines[1] ?? '';
  const count = (g: Group, word: string) => `${g.rows.length} ${word}`;
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Consort', emoji: true } },
    context(`Updated ${stamp}  ·  🟠 ${count(groups.reply, groups.reply.rows.length === 1 ? 'needs your reply' : 'need your reply')}  ·  📦 ${count(groups.ready, 'ready to merge')}  ·  🔄 ${count(groups.working, 'working')}  ·  ✅ ${count(groups.completed, 'completed')}`),
  ];
  for (const group of [groups.reply, groups.ready, groups.working, groups.completed]) {
    blocks.push(divider(), section(`${group.heading} · ${group.rows.length}`));
    if (!group.rows.length) blocks.push(section(`_${group.empty}_`));
    else blocks.push(...packed(group.rows.map(r => taskText(r, group))));
    for (const note of group.notes) blocks.push(context(`_${note}_`));
  }
  blocks.push(divider(), section('⚡ *AI capacity*'));
  blocks.push(...(accounts.length ? packed(accounts.map(accountText)) : [section('_No accounts configured._')]));
  blocks.push(context('Reply in a task’s thread. This message updates in place.'));
  if (blocks.length > MAX_BLOCKS) { const kept = blocks.filter(b => (b as { type: string }).type !== 'divider'); return kept.length > MAX_BLOCKS ? [...kept.slice(0, MAX_BLOCKS - 1), context('_More in the CLI: `consort-cli view`._')] : kept; }
  return blocks;
}
