/**
 * The master monitor as native Slack Block Kit: a card per open task with link buttons, the
 * completed work and AI capacity as tables inside titled containers. Text stays sharp at any width
 * and in either theme, and nothing is uploaded. Built from the monitor text (shared/slackMonitor.ts)
 * after the PHI guard has run, so a guard replacement never reaches a block as task content.
 */
const LIMIT = 2900;
const MAX_BLOCKS = 50;
type Row = { icon: string; kind: string; title: string; thread?: string; pending: boolean; unread?: number; ci?: string; byline?: string; status: string; stage?: { name: string; n: number; total: number }; cost?: string; age?: string; action?: string; links: { label: string; url: string }[] };
type Group = { key: 'reply' | 'nudge' | 'ready' | 'working'; icon: string; heading: string; empty: string; rows: Row[]; notes: string[] };
type Block = Record<string, unknown>;

const mrkdwn = (text: string, max = LIMIT) => ({ type: 'mrkdwn', text: text.length > max ? text.slice(0, max - 1) + '…' : text });
const section = (text: string): Block => ({ type: 'section', text: mrkdwn(text) });
const context = (text: string): Block => ({ type: 'context', elements: [mrkdwn(text)] });
const divider = (): Block => ({ type: 'divider' });
/** The banner: the white muses mark and the word Consort centered on a 1280x260 transparent PNG, served from the public repo. Slack shows it about 500px wide, so the narrow margins make the mark larger. Block Kit cannot center text, so the head is one image. */
export const CONSORT_BANNER_URL = 'https://raw.githubusercontent.com/mitchmeyer1/consort-ade/main/build/consort-banner-slack.png';
/** Monitor text is HTML-escaped for mrkdwn; table cells and plain text need the characters back. */
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const unlink = (s: string) => decode(s.replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, '$1'));
const link = (url: string | undefined, label: string) => (url ? `<${url}|${label}>` : label);
const button = (label: string, url: string, id: string, style?: 'primary' | 'danger'): Block => ({ type: 'button', text: { type: 'plain_text', text: label, emoji: false }, url, action_id: id, ...(style ? { style } : {}) });
/** `▰▰▱▱▱`: stages done out of the total, in text that every Slack client renders. */
export const bar = (done: number, total: number) => (total > 0 && total <= 30 ? '▰'.repeat(Math.max(0, Math.min(done, total))) + '▱'.repeat(Math.max(0, total - done)) : '');
type Cell = { type: 'raw_text'; text: string } | { type: 'rich_text'; elements: unknown[] };
/** Slack rejects an empty cell, so a blank shows as a dash. */
const cell = (text: string): Cell => ({ type: 'raw_text', text: unlink(text) || '—' });
const richCell = (parts: ({ text: string; url?: string; bold?: boolean })[]): Cell => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: parts.map(p => p.url ? { type: 'link', url: p.url, text: decode(p.text) } : { type: 'text', text: decode(p.text), ...(p.bold ? { style: { bold: true } } : {}) }) }] });
const table = (id: string, header: string[], rows: Cell[][], settings: { align?: string; is_wrapped?: boolean }[]): Block => ({ type: 'table', block_id: id, column_settings: settings, rows: [header.map(h => richCell([{ text: h, bold: true }])), ...rows] });
/** A full-width titled box; the only block kind Slack lets span the whole message. */
const container = (id: string, title: string, subtitle: { type: 'plain_text' | 'mrkdwn'; text: string } | undefined, children: Block[], look: { collapsed?: boolean; divider?: boolean } = { divider: true }): Block => ({ type: 'container', block_id: id, title: { type: 'plain_text', text: title }, ...(subtitle ? { subtitle } : {}), width: 'full', ...(look.collapsed ? { is_collapsible: true, default_collapsed: true } : { has_header_divider: !!look.divider }), child_blocks: children.slice(0, 10) });

/** Split on ' · ' without breaking a `<url|label>` whose label contains the separator. */
function parts(line: string): string[] {
  const tokens: string[] = [];
  const masked = line.replace(/<https:\/\/[^>]+>/g, m => { tokens.push(m); return `\u0000${tokens.length - 1}\u0000`; });
  return masked.split(' · ').map(p => p.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]).trim());
}
function parseRow(line: string, details: string[]): Row {
  const p = parts(line);
  const [icon, ...kindWords] = p[0].split(' ');
  // ` (3 unread)`: Consort posts in the thread since the owner last wrote there (shared/slackMonitor.ts)
  const unread = Number((p[1] ?? '').match(/ \((\d+) unread\)$/)?.[1] ?? 0);
  const titleRaw = (p[1] ?? '').replace(/ \(\d+ unread\)$/, '');
  const pending = / \(Slack thread pending\)$/.test(titleRaw);
  const linked = titleRaw.replace(/ \(Slack thread pending\)$/, '').match(/^<(https:\/\/[^|>]+)\|(.+)>$/);
  const row: Row = { icon, kind: kindWords.join(' '), title: linked ? linked[2] : titleRaw.replace(/ \(Slack thread pending\)$/, ''), thread: linked?.[1], pending, ...(unread ? { unread } : {}), status: '', links: [] };
  const stageOf = (s: string) => { const m = s.match(/^(.*?)\s*(\d+)\/(\d+)$/); return m ? { name: m[1], n: Number(m[2]), total: Number(m[3]) } : undefined; };
  if (p.length >= 7) { row.byline = p[2]; row.status = p[3]; row.stage = stageOf(p[4]); row.cost = p[5]; row.age = p.slice(6).join(' · '); }
  else { row.status = p[2] ?? ''; row.stage = stageOf(p[3] ?? ''); }
  const labels: Record<string, string> = { ticket: 'ClickUp', github: 'GitHub', 'merge PR': 'Merge PR' };
  for (const d of details) {
    const found = [...d.matchAll(/<(https:\/\/[^|>]+)\|(ticket|github|merge PR)>/g)];
    if (found.length) row.links.push(...found.map(m => ({ label: labels[m[2]], url: m[1] })));
    else if (d.startsWith('PR: ')) row.ci = d.slice(4);
    else row.action = row.action ? `${row.action} ${d}` : d;
  }
  return row;
}
const CI_MARK: Record<string, string> = { 'CI passing': '🟢', 'CI running': '🟡', 'CI failing': '🔴', 'No CI': '⚪' };
/** The PR's CI verdict with a coloured dot. */
const prLabels = (row: Row) => row.ci ? `${CI_MARK[row.ci] ?? ''} ${row.ci}`.trim() : '';
const notable = (status: string) => (['RUNNING', 'WAITING', 'READY TO MERGE', 'DONE', ''].includes(status) ? undefined : status);
const byline = (row: Row) => row.byline?.replace(/^author: /, 'by ');
/** One card per open task: title, who and how much, the current action, the stage bar, and up to three link buttons. */
function card(row: Row, group: Group, index: number): Block {
  const primary = group.key === 'reply' ? 'thread' : group.key === 'ready' ? 'Merge PR' : group.key === 'nudge' ? 'GitHub' : undefined;
  const buttons: Block[] = [];
  // unread Consort posts turn the thread button red; Slack has no badge, so the count is in the label
  const threadLabel = `${group.key === 'reply' ? 'Reply in thread' : 'Open thread'}${row.unread ? ` · ${row.unread} new` : ''}`;
  if (row.thread) buttons.push(button(threadLabel, row.thread, `thread-${index}`, row.unread ? 'danger' : primary === 'thread' ? 'primary' : undefined));
  for (const l of row.links) buttons.push(button(l.label, l.url, `${l.label.toLowerCase().replace(/\W+/g, '-')}-${index}`, primary === l.label ? 'primary' : undefined));
  const status = notable(row.status);
  const subtext = [row.stage ? `${row.stage.name} ${row.stage.n}/${row.stage.total}   ${bar(group.key === 'ready' ? row.stage.n : row.stage.n - 1, row.stage.total)}` : '', prLabels(row), status ? `*${status}*` : '', row.pending ? '_Slack thread pending_' : ''].filter(Boolean).join('   ·   ');
  const subtitle = [row.kind, byline(row), row.cost, row.age].filter(Boolean).join('   ·   ');
  return {
    type: 'card', block_id: `task-${index}`,
    title: mrkdwn(row.title, 150),
    ...(subtitle ? { subtitle: mrkdwn(subtitle, 150) } : {}),
    ...(row.action ? { body: mrkdwn(row.action, 200) } : {}),
    ...(subtext ? { subtext: mrkdwn(subtext, 200) } : {}),
    ...(buttons.length ? { actions: buttons.slice(0, 3) } : {}),
  };
}
/** Plain rows, packed into as few sections as fit, for anything that no longer fits as a card. */
function compact(row: Row): string {
  const status = notable(row.status);
  return [`*${link(row.thread, row.title)}*`, row.unread ? `🔴 ${row.unread} new` : '', status ? `*${status}*` : '', row.ci ?? '', byline(row), row.cost, row.age, row.action ? `_${row.action}_` : '', ...row.links.map(l => link(l.url, l.label))].filter(Boolean).join(' · ');
}
function packed(texts: string[]): Block[] {
  const out: Block[] = []; let chunk = '';
  for (const t of texts) {
    const text = t.length > LIMIT ? t.slice(0, LIMIT - 1) + '…' : t;
    if (chunk && chunk.length + text.length + 2 > LIMIT) { out.push(section(chunk)); chunk = ''; }
    chunk += (chunk ? '\n\n' : '') + text;
  }
  if (chunk) out.push(section(chunk));
  return out;
}
function completedRow(row: Row): Cell[] {
  return [
    richCell([{ text: unlink(row.title), url: row.thread }]),
    cell((byline(row) ?? '').replace(/^by /, '')),
    cell(row.cost ?? ''),
    cell((row.age ?? '').replace(/^finished /, '')),
    richCell(row.links.flatMap((l, i) => [...(i ? [{ text: '  ·  ' }] : []), { text: l.label, url: l.url }])),
  ];
}
export type AccountUsage = { name: string; blocked: boolean; status: string; windows: { label: string; percent: number }[]; detail: string; resets?: string };
/** One monitor account line: `🟢 Claude 1 · available · 5-hour 42% · weekly 20% · resets Oct 30, 3:00 PM EDT · usage 3m ago`, or a blocked one with its reason, resume time and windows. */
export function parseAccount(line: string): AccountUsage {
  const p = parts(line); const name = p[0].replace(/^\S+ /, ''); const all = p.slice(1);
  // The last weekly window's reset rides apart from the detail.
  const resets = all.find((r) => r.startsWith('resets '))?.slice(7), rest = all.filter((r) => !r.startsWith('resets '));
  const windows = rest.flatMap((r) => { const m = r.match(/^(.+?) (\d+)%$/); return m ? [{ label: m[1]!, percent: Number(m[2]) }] : []; });
  const peak = windows.length ? Math.max(...windows.map((w) => w.percent)) : undefined;
  // A blocked line keeps its windows after the reason and resume time, so every bar still draws.
  if (p[0].startsWith('🔴')) return { name, blocked: true, status: 'Blocked', windows, ...(resets ? { resets } : {}), detail: rest.slice(0, rest.findIndex((r) => r.startsWith('resume ')) + 1 || undefined).filter((r) => !/ \d+%$/.test(r)).join(' · ').replace(/^blocked: /, '') };
  if (peak === undefined) return { name, blocked: false, status: 'Unavailable', windows, ...(resets ? { resets } : {}), detail: rest.filter((r) => r !== 'usage unavailable').join(' · ') || 'no reading yet' };
  return { name, blocked: false, status: peak <= 50 ? 'Available' : peak <= 90 ? 'Busy' : 'Nearly full', windows, ...(resets ? { resets } : {}), detail: rest.filter((r) => r !== 'available').join(' · ') };
}
/**
 * The usage chart: Slack's own bar chart, one bar per limit window per account (5-hour, weekly, and a model's
 * weekly where the plan has one), in percent of the limit. Slack draws bars upright only. A blocked account reads as full.
 */
function usageChart(accounts: AccountUsage[], now: number): Block | undefined {
  const charted = accounts.filter((a) => a.blocked || a.windows.length).slice(0, 20);
  const labels = [...new Set(charted.flatMap((a) => a.windows.map((w) => w.label)))].slice(0, 12);
  if (!charted.length || !labels.length) return undefined;
  const value = (a: AccountUsage, label: string) => a.blocked && !a.windows.length ? 100 : Math.max(0, Math.min(100, a.windows.find((w) => w.label === label)?.percent ?? 0));
  const name = (label: string) => (label.toLowerCase() === 'weekly' ? 'Weekly' : label.slice(0, 20));
  return {
    type: 'data_visualization', block_id: `usage-chart-${now}`, title: 'AI usage, % of each limit',
    chart: { type: 'bar', series: labels.map((label) => ({ name: name(label), data: charted.map((a) => ({ label: a.name.slice(0, 20), value: value(a, label) })) })), axis_config: { categories: charted.map((a) => a.name.slice(0, 20)), y_label: '% used' } },
  };
}
/** What the chart cannot say: which accounts are blocked and until when, and which have no reading. */
function usageNotes(accounts: AccountUsage[]): string[] {
  return accounts.filter((a) => a.blocked || !a.windows.length).map((a) => `*${a.name}* ${a.blocked ? 'blocked' : 'unavailable'}: ${a.detail}`);
}

/** The account lines of a master monitor text, parsed; empty for anything else. */
export function monitorAccounts(safe: string): AccountUsage[] {
  const lines = safe.split('\n');
  if (!lines[0]?.startsWith('*📊 Consort master monitor*')) return [];
  const start = lines.indexOf('*Accounts*');
  if (start < 0) return [];
  const out: AccountUsage[] = [];
  for (const line of lines.slice(start + 1)) { if (!line) break; if (/^[🔴⚪🟢🟡🟠] /u.test(line)) out.push(parseAccount(line)); }
  return out;
}
/** The System section of a master monitor text as `label → value` (cli/systemSnapshot.ts); empty for anything else. */
export function monitorSystem(safe: string): Record<string, string> {
  const lines = safe.split('\n');
  if (!lines[0]?.startsWith('*📊 Consort master monitor*')) return {};
  const start = lines.indexOf('*System*'), out: Record<string, string> = {};
  if (start < 0) return out;
  for (const line of lines.slice(start + 1)) { if (!line) break; const m = line.match(/^(\w+): (.+)$/); if (m) out[m[1]!] = m[2]!; }
  return out;
}
/** A rendered usage panel already uploaded to Slack (cli/slackUsageGraphic.ts), shown in place of the chart. */
export type UsageImage = { fileId: string; alt: string };
/** The monitor text's open tasks by group, its completed rows and its account lines; undefined for any other text. */
function parseMonitor(safe: string) {
  const lines = safe.split('\n');
  if (!lines[0].startsWith('*📊 Consort master monitor*') || !lines.includes('*Working*')) return undefined;
  const groups: Record<Group['key'], Group> = {
    reply: { key: 'reply', icon: '🟠', heading: 'Needs your reply', empty: 'Nothing needs your reply.', rows: [], notes: [] },
    nudge: { key: 'nudge', icon: '👉', heading: 'Nudge', empty: 'Nobody to nudge.', rows: [], notes: [] },
    ready: { key: 'ready', icon: '📦', heading: 'Ready to merge', empty: 'Nothing waiting to be merged.', rows: [], notes: [] },
    working: { key: 'working', icon: '🔄', heading: 'Working', empty: 'No tasks in progress.', rows: [], notes: [] },
  };
  const completed: Row[] = []; const completedNotes: string[] = []; const accounts: string[] = [];
  let sectionName = '';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^\*([^*]+)\*$/);
    if (heading) { sectionName = heading[1]; continue; }
    if (!line || line === 'STATUS: MONITORING' || line.startsWith('Updated ') || line.startsWith('Open a ticket title') || line.startsWith('No ')) continue;
    if (sectionName === 'Accounts') { accounts.push(line); continue; }
    const group = sectionName.startsWith('Working') ? groups.working : sectionName.startsWith('Ready') ? groups.ready : sectionName.startsWith('Completed') ? undefined : null;
    if (group === null) continue;
    if (line.startsWith('… ')) { (group ? group.notes : completedNotes).push(line); continue; }
    const details: string[] = [];
    while (lines[i + 1]?.startsWith('   ')) details.push(lines[++i].trim());
    const row = parseRow(line, details);
    if (!group) completed.push(row);
    else (group.key === 'working' && row.icon === '🟠' ? groups.reply : group.key === 'working' && row.icon === '👉' ? groups.nudge : group).rows.push(row);
  }
  return { lines, groups, completed, completedNotes, accounts };
}
/** How many tasks sit in each open group, counting the ones a `… N more` note leaves out. Undefined for any other text. */
export function monitorCounts(safe: string): Record<Group['key'], number> | undefined {
  const parsed = parseMonitor(safe);
  if (!parsed) return undefined;
  const more = (g: Group) => g.notes.reduce((n, note) => n + Number(note.match(/^… (\d+) more/)?.[1] ?? 0), 0);
  const { reply, nudge, ready, working } = parsed.groups;
  return { reply: reply.rows.length, nudge: nudge.rows.length, ready: ready.rows.length + more(ready), working: working.rows.length + more(working) };
}
/** Blocks for a master monitor text; undefined for anything else (guard notices, legacy posts, tests). The head is the uploaded header picture when there is one, else the banner. */
export function monitorBlockKit(safe: string, now = Date.now(), usage?: UsageImage, head?: UsageImage): Block[] | undefined {
  const monitor = parseMonitor(safe);
  if (!monitor) return undefined;
  const { lines, groups, completed, completedNotes, accounts } = monitor;
  const updated = lines[1]?.match(/^Updated (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/);
  const stamp = updated ? `<!date^${Math.floor(Date.parse(`${updated[1]}T${updated[2]}:00Z`) / 1000)}^{date_short_pretty} {time}|${lines[1]}>` : lines[1] ?? '';
  // The head is the banner alone; each group heading carries its own count. Image blocks stay at top level:
  // Slack draws one frame around them there, and an uploaded file inside a container never renders.
  const blocks: Block[] = [head ? { type: 'image', block_id: `head-${now}`, slack_file: { id: head.fileId }, alt_text: head.alt.slice(0, 2000) } : { type: 'image', block_id: `head-${now}`, image_url: CONSORT_BANNER_URL, alt_text: 'Consort' }];
  let index = 0;
  const groupBlocks = new Map<Group['key'], Block[]>();
  // Empty groups are left out; the summary line still carries their counts.
  for (const group of [groups.reply, groups.nudge, groups.ready, groups.working]) {
    if (!group.rows.length && !group.notes.length) continue;
    const cards = group.rows.map(r => card(r, group, index++));
    // Two or more cards scroll sideways in a carousel (at most ten cards each), so a busy group does not make the post tall.
    const shown = cards.length > 1 ? Array.from({ length: Math.ceil(cards.length / 10) }, (_, i): Block => ({ type: 'carousel', block_id: `${group.key}-carousel-${i}`, elements: cards.slice(i * 10, i * 10 + 10) })) : cards;
    groupBlocks.set(group.key, shown);
    blocks.push(divider(), section(`*${group.heading}*   ·   ${group.rows.length}`), ...shown);
    for (const note of group.notes) blocks.push(context(`_${note}_`));
  }
  blocks.push(divider());
  if (completed.length) blocks.push(container(`completed-${now}`, 'Completed', { type: 'plain_text', text: `most recent ${completed.length}` },
    [table(`completed-table-${now}`, ['Task', 'Author', 'Cost', 'Finished', 'Links'], completed.map(completedRow), [{ is_wrapped: true }, {}, { align: 'right' }, {}, {}]), ...completedNotes.map(n => context(`_${n}_`))], { collapsed: true }));
  if (!blocks.some(b => b.type === 'card' || b.type === 'carousel' || b.type === 'container')) blocks.push(context('_Nothing open and nothing finished yet._'));
  const parsed = accounts.map(parseAccount);
  // The rendered panel says everything the chart and notes would; without one, Slack's own chart stands in.
  const chart = usage ? undefined : usageChart(parsed, now);
  if (usage) blocks.push({ type: 'image', block_id: `usage-${now}`, slack_file: { id: usage.fileId }, alt_text: usage.alt.slice(0, 2000) });
  else if (chart) blocks.push(chart);
  else if (parsed.length) blocks.push(section('*AI usage*'));
  if (!usage) for (const note of usageNotes(parsed)) blocks.push(context(note));
  // The rendered panel carries the System box too; without it, one line says the same.
  const system = monitorSystem(safe);
  if (!usage && Object.keys(system).length) blocks.push(context(`*System*  ·  ${Object.entries(system).filter(([k]) => !k.endsWith('30')).map(([k, v]) => `${k} ${v}`).join('  ·  ')}`));
  blocks.push(context(`Updated ${stamp}  ·  Reply in a task’s thread. This message updates in place.`));
  // Too many open tasks for Slack's block limit: the later groups fall back to packed text rows, one section per few tasks.
  for (const group of [groups.working, groups.ready, groups.nudge, groups.reply]) {
    if (blocks.length <= MAX_BLOCKS) break;
    const cards = groupBlocks.get(group.key); if (!cards?.length) continue;
    const at = blocks.indexOf(cards[0]); const replacement = packed(group.rows.map(compact));
    blocks.splice(at, cards.length, ...replacement);
  }
  return blocks.length > MAX_BLOCKS ? blocks.filter(b => b.type !== 'divider').slice(0, MAX_BLOCKS) : blocks;
}
