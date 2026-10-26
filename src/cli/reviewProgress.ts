/** Head-specific review checkpoints and conservative scope selection for repeat reviews. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export type ReviewScope = { head: string; base: string; context: string; from?: string; files: string[]; lines: number; small: boolean };
export const reviewContextChanged = (files: string[]) => files.some(f=>/(^|\/)(?:package\.json|.*lock.*|tsconfig[^/]*|[^/]*config[^/]*|\.ai-review-rules\.md|CLAUDE\.md|AGENTS\.md|Dockerfile[^/]*|.*\.ya?ml)$/.test(f));
export const smallReview = (files: string[], lines: number) => files.length>0 && files.length<=2 && lines<=200 && !reviewContextChanged(files) && !files.some(f=>/auth|migration|schema|payment|security/i.test(f));
export function readReviewJson<T>(file: string): T | undefined { try { return JSON.parse(readFileSync(file,'utf8')); } catch { return undefined; } }
export function saveReviewJson(file: string, value: unknown) { const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2));renameSync(tmp,file); }
export async function reviewScope(head: string, base: string, dir: string, git: (args:string[])=>Promise<string>, policy: string): Promise<ReviewScope> {
  const mergeBase=(await git(['merge-base',`origin/${base}`,head])).trim();
  const context=createHash('sha256').update(mergeBase+'\n'+policy).digest('hex');
  const previous=readReviewJson<ReviewScope>(join(dir,'previous-scope.json'));
  let from: string | undefined;
  if(previous && previous.context===context && /^[a-f0-9]{40,64}$/.test(previous.head)) {
    try { await git(['merge-base','--is-ancestor',previous.head,head]); from=previous.head; } catch { /* Rebases require a full review. */ }
  }
  const changed=(await git(['diff','--name-only','-z',from??mergeBase,head])).split('\0').filter(Boolean);
  if(from && reviewContextChanged(changed)) from=undefined;
  const files=from ? changed : (await git(['diff','--name-only','-z',mergeBase,head])).split('\0').filter(Boolean);
  const stats=await git(['diff','--numstat',from??mergeBase,head]);
  let lines=0;
  for(const row of stats.trim().split('\n').filter(Boolean)){const [a,b]=row.split('\t');lines+=/^\d+$/.test(a)&&/^\d+$/.test(b)?Number(a)+Number(b):100000;}
  return {head,base,context,from,files,lines,small:smallReview(files,lines)};
}
export function scopeGuidance(scope: ReviewScope): string {
  return `${scope.from ? `Incremental review: compare ${scope.from}..${scope.head}. Read the previous overview in the archived round and recheck every finding in previous.json. Review new changes and affected callers; expand beyond listed files when a change can affect them. Do not reread unchanged unrelated areas.` : 'Full review: cover the whole PR and affected callers.'}\nChanged scope: ${JSON.stringify(scope.files)}. ${scope.small?'This is a small change: use one reviewer, no delegated readers.':'Choose 1 to 10 areas proportional to the changed scope.'}`;
}
export class ReviewCheckpoints {
  private dir: string;
  private scope: ReviewScope;
  constructor(dir: string, scope: ReviewScope) { this.dir=dir;this.scope=scope;mkdirSync(join(dir,'areas'),{recursive:true}); }
  private file(key: string) { return join(this.dir,'areas',createHash('sha256').update(JSON.stringify({scope:this.scope,key})).digest('hex')+'.json'); }
  read<T>(key:string): T | undefined { return readReviewJson<{value:T}>(this.file(key))?.value; }
  save(key:string,value:unknown) { saveReviewJson(this.file(key),{value}); }
}
