/**
 * The master monitor as native Slack Block Kit: a card per open task with link buttons, the
 * completed work and AI capacity as tables inside titled containers. Text stays sharp at any width
 * and in either theme, and nothing is uploaded. Built from the monitor text (shared/slackMonitor.ts)
 * after the PHI guard has run, so a guard replacement never reaches a block as task content.
 */
const LIMIT = 2900;
const MAX_BLOCKS = 50;
type Row = { icon: string; kind: string; title: string; thread?: string; pending: boolean; byline?: string; status: string; stage?: { name: string; n: number; total: number }; cost?: string; age?: string; action?: string; links: { label: string; url: string }[] };
type Group = { key: 'reply' | 'nudge' | 'ready' | 'working'; icon: string; heading: string; empty: string; rows: Row[]; notes: string[] };
type Block = Record<string, unknown>;

const mrkdwn = (text: string, max = LIMIT) => ({ type: 'mrkdwn', text: text.length > max ? text.slice(0, max - 1) + '…' : text });
const section = (text: string): Block => ({ type: 'section', text: mrkdwn(text) });
const context = (text: string): Block => ({ type: 'context', elements: [mrkdwn(text)] });
const divider = (): Block => ({ type: 'divider' });
/** The banner: the white muses mark and the word Consort centered on a wide transparent PNG, served from the public repo. Block Kit cannot center text, so the head is one image. */
export const CONSORT_BANNER_URL = 'https://raw.githubusercontent.com/mitchmeyer1/consort-ade/main/build/consort-banner-white.png';
/** Monitor text is HTML-escaped for mrkdwn; table cells and plain text need the characters back. */
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const unlink = (s: string) => decode(s.replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, '$1'));
const link = (url: string | undefined, label: string) => (url ? `<${url}|${label}>` : label);
const button = (label: string, url: string, id: string, primary = false): Block => ({ type: 'button', text: { type: 'plain_text', text: label, emoji: false }, url, action_id: id, ...(primary ? { style: 'primary' } : {}) });
/** `▰▰▱▱▱`: stages done out of the total, in text that every Slack client renders. */
/** The usage meter: ten squares, the only coloured text Slack draws. Blue to 50%, yellow to 90%, orange above; white for the rest. */
export const meter = (percent: number) => { const filled = Math.round(Math.max(0, Math.min(100, percent)) / 10); const square = percent <= 50 ? '🟦' : percent <= 90 ? '🟨' : '🟧'; return square.repeat(filled) + '⬜'.repeat(10 - filled); };
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
  const titleRaw = p[1] ?? '';
  const pending = / \(Slack thread pending\)$/.test(titleRaw);
  const linked = titleRaw.replace(/ \(Slack thread pending\)$/, '').match(/^<(https:\/\/[^|>]+)\|(.+)>$/);
  const row: Row = { icon, kind: kindWords.join(' '), title: linked ? linked[2] : titleRaw.replace(/ \(Slack thread pending\)$/, ''), thread: linked?.[1], pending, status: '', links: [] };
  const stageOf = (s: string) => { const m = s.match(/^(.*?)\s*(\d+)\/(\d+)$/); return m ? { name: m[1], n: Number(m[2]), total: Number(m[3]) } : undefined; };
  if (p.length >= 7) { row.byline = p[2]; row.status = p[3]; row.stage = stageOf(p[4]); row.cost = p[5]; row.age = p.slice(6).join(' · '); }
  else { row.status = p[2] ?? ''; row.stage = stageOf(p[3] ?? ''); }
  const labels: Record<string, string> = { ticket: 'ClickUp', github: 'GitHub', 'merge PR': 'Merge PR' };
  for (const d of details) {
    const found = [...d.matchAll(/<(https:\/\/[^|>]+)\|(ticket|github|merge PR)>/g)];
    if (found.length) row.links.push(...found.map(m => ({ label: labels[m[2]], url: m[1] })));
    else row.action = row.action ? `${row.action} ${d}` : d;
  }
  return row;
}
const notable = (status: string) => (['RUNNING', 'WAITING', 'READY TO MERGE', 'DONE', ''].includes(status) ? undefined : status);
const byline = (row: Row) => row.byline?.replace(/^author: /, 'by ');
/** One card per open task: title, who and how much, the current action, the stage bar, and up to three link buttons. */
function card(row: Row, group: Group, index: number): Block {
  const primary = group.key === 'reply' ? 'thread' : group.key === 'ready' ? 'Merge PR' : group.key === 'nudge' ? 'GitHub' : undefined;
  const buttons: Block[] = [];
  if (row.thread) buttons.push(button(group.key === 'reply' ? 'Reply in thread' : 'Open thread', row.thread, `thread-${index}`, primary === 'thread'));
  for (const l of row.links) buttons.push(button(l.label, l.url, `${l.label.toLowerCase().replace(/\W+/g, '-')}-${index}`, primary === l.label));
  const status = notable(row.status);
  const subtext = [row.stage ? `${row.stage.name} ${row.stage.n}/${row.stage.total}   ${bar(group.key === 'ready' ? row.stage.n : row.stage.n - 1, row.stage.total)}` : '', status ? `*${status}*` : '', row.pending ? '_Slack thread pending_' : ''].filter(Boolean).join('   ·   ');
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
  return [`*${link(row.thread, row.title)}*`, status ? `*${status}*` : '', byline(row), row.cost, row.age, row.action ? `_${row.action}_` : '', ...row.links.map(l => link(l.url, l.label))].filter(Boolean).join(' · ');
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
function accountRow(line: string): Cell[] {
  const p = parts(line); const name = p[0].replace(/^\S+ /, ''); const rest = p.slice(1);
  if (p[0].startsWith('🔴')) return [cell(name), richCell([{ text: 'Blocked', bold: true }]), cell(''), cell(rest.join(' · ').replace(/^blocked: /, ''))];
  const percents = rest.flatMap(r => [...r.matchAll(/(\d+)%/g)].map(m => Number(m[1])));
  const peak = percents.length ? Math.max(...percents) : undefined;
  if (peak === undefined) return [cell(name), cell('Unavailable'), cell(''), cell(rest.filter(r => r !== 'usage unavailable').join(' · ') || 'no reading yet')];
  return [cell(name), cell(peak <= 50 ? 'Available' : peak <= 90 ? 'Busy' : 'Nearly full'), cell(`${meter(peak)}  ${peak}%`), cell(rest.filter(r => r !== 'available').join(' · '))];
}

/** Blocks for a master monitor text; undefined for anything else (guard notices, legacy posts, tests). */
export function monitorBlockKit(safe: string, now = Date.now()): Block[] | undefined {
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
  const updated = lines[1]?.match(/^Updated (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/);
  const stamp = updated ? `<!date^${Math.floor(Date.parse(`${updated[1]}T${updated[2]}:00Z`) / 1000)}^{date_short_pretty} {time}|${lines[1]}>` : lines[1] ?? '';
  // The head is the banner alone; each group heading carries its own count.
  const blocks: Block[] = [{ type: 'image', image_url: CONSORT_BANNER_URL, alt_text: 'Consort' }];
  let index = 0;
  const groupBlocks = new Map<Group['key'], Block[]>();
  // Empty groups are left out; the summary line still carries their counts.
  for (const group of [groups.reply, groups.nudge, groups.ready, groups.working]) {
    if (!group.rows.length && !group.notes.length) continue;
    const cards = group.rows.map(r => card(r, group, index++));
    groupBlocks.set(group.key, cards);
    blocks.push(divider(), section(`*${group.heading}*   ·   ${group.rows.length}`), ...cards);
    for (const note of group.notes) blocks.push(context(`_${note}_`));
  }
  blocks.push(divider());
  if (completed.length) blocks.push(container(`completed-${now}`, 'Completed', { type: 'plain_text', text: `most recent ${completed.length}` },
    [table(`completed-table-${now}`, ['Task', 'Author', 'Cost', 'Finished', 'Links'], completed.map(completedRow), [{ is_wrapped: true }, {}, { align: 'right' }, {}, {}]), ...completedNotes.map(n => context(`_${n}_`))], { collapsed: true }));
  if (accounts.length) blocks.push(container(`capacity-${now}`, 'AI capacity', undefined,
    [table(`capacity-table-${now}`, ['Account', 'Status', 'Usage', 'Detail'], accounts.map(accountRow), [{}, {}, {}, { is_wrapped: true }])]));
  if (!blocks.some(b => b.type === 'card' || b.type === 'container')) blocks.push(context('_Nothing open and nothing finished yet._'));
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
