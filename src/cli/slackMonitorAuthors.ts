/** Resolve actual PR authors for the monitor; never substitute the signed-in GitHub user. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task } from './state';
const run = promisify(execFile);
const cache = new Map<string,string>();
export async function monitorAuthors(tasks: Task[], lookup = async (url: string) => {
  const result = await run('gh',['pr','view',url,'--json','author','--jq','.author.login'],{timeout:10000});
  return result.stdout.trim();
}): Promise<Map<string,string>> {
  const authors = new Map<string,string>();
  await Promise.all(tasks.map(async task => {
    if(task.kind==='review' && task.review?.author) { authors.set(task.id,task.review.author); return; }
    const url=task.review?.url ?? task.feature?.prs?.at(-1);
    if(!url || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) return;
    try {
      const author=cache.get(url) ?? await lookup(url);
      if(/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\[bot\])?$/.test(author)) { cache.set(url,author);authors.set(task.id,author); }
    } catch { /* Retry failed lookups next refresh; show an explicit unavailable author. */ }
  }));
  return authors;
}
