import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewScope,scopeGuidance,ReviewCheckpoints,saveReviewJson,smallReview} from '../src/cli/reviewProgress.ts';
const sha='a'.repeat(40),head='b'.repeat(40);
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'review-progress-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function git({base='base1',files=['src/test.ts'],lines=100,ancestor=true}={}){return async args=>{
 if(args[0]==='merge-base'&&args[1]==='--is-ancestor'){if(!ancestor)throw Error('rebased');return '';}
 if(args[0]==='merge-base')return base;
 if(args.includes('--name-only'))return files.join('\0')+'\0';
 if(args.includes('--numstat'))return `${lines}\t0\tsrc/test.ts\n`;
 throw Error('unexpected git request '+args);
};}
test('incremental reviews retain prior head only when base, policy and ancestry match',async t=>{
 const dir=fixture(t);const first=await reviewScope(sha,'main',dir,git(),'policy');
 saveReviewJson(join(dir,'previous-scope.json'),first);
 const next=await reviewScope(head,'main',dir,git(),'policy');assert.equal(next.from,sha);assert.equal(next.small,true);assert.match(scopeGuidance(next),/affected callers/);
 assert.equal((await reviewScope(head,'main',dir,git({base:'base2'}),'policy')).from,undefined);
 assert.equal((await reviewScope(head,'main',dir,git(),'changed-policy')).from,undefined);
 assert.equal((await reviewScope(head,'main',dir,git({ancestor:false}),'policy')).from,undefined);
 assert.equal((await reviewScope(head,'main',dir,git({files:['package.json']}),'policy')).from,undefined);
});
test('review checkpoints survive restart and invalidate for head, scope or prompt changes',t=>{
 const dir=fixture(t),scope={head,base:'main',context:'rules',files:['src/a.ts'],lines:20,small:true};
 const first=new ReviewCheckpoints(dir,scope);first.save('prompt-a',[]);first.save('prompt-b',[{title:'finding'}]);
 const restored=new ReviewCheckpoints(dir,scope);assert.deepEqual(restored.read('prompt-a'),[]);assert.equal(restored.read('prompt-b')[0].title,'finding');
 assert.equal(restored.read('new-prompt'),undefined);
 assert.equal(new ReviewCheckpoints(dir,{...scope,head:sha}).read('prompt-b'),undefined);
 assert.equal(new ReviewCheckpoints(dir,{...scope,context:'different-rules'}).read('prompt-b'),undefined);
 writeFileSync(join(dir,'previous-scope.json'),'{bad json');assert.doesNotThrow(()=>new ReviewCheckpoints(dir,scope));
});
test('only bounded low-risk changes use a single reviewer',()=>{
 assert.ok(smallReview(['tests/navbar.test.ts'],153));
 assert.ok(!smallReview(['src/auth.ts'],10));assert.ok(!smallReview(['package.json'],10));
 assert.ok(!smallReview(['a','b','c'],20));assert.ok(!smallReview(['a'],201));assert.ok(!smallReview([],0));
});
