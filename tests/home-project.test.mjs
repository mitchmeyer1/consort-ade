// A home project: a plain folder (no git) that owns one chat scope. The /ship scope on ~/command-center
// is adopted by the home when they share a path, so /ship keeps working and no second scope appears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homeScopes, homeWorktree, isHome, isScratch, scratchChats } from "../src/shared/scratch.ts";

const project = { id: "p1", name: "command-center", path: "/Users/x/command-center", defaultBase: "", kind: "home" };

test("isHome only for kind=home", () => {
  assert.equal(isHome(project), true);
  assert.equal(isHome({ ...project, kind: undefined }), false);
  assert.equal(isHome({ ...project, kind: "workspace" }), false);
  assert.equal(isHome(undefined), false);
});

test("homeWorktree is a root scratch scope at the project's path, nothing git-shaped", () => {
  const w = homeWorktree("w1", project);
  assert.equal(w.projectId, "p1");
  assert.equal(w.path, project.path);
  assert.equal(w.name, "command-center");
  assert.equal(w.branch, "");
  assert.equal(w.scratch, true);
  assert.equal(w.root, true);
  assert.equal(isScratch(w), true);
});

test("scratchChats lists only chats in unowned scopes; a home's chats belong to the home", () => {
  const free = { id: "s", projectId: "", name: "Chats", title: "Chats", path: "", branch: "", archived: false, scratch: true };
  const ship = { id: "ship-command-center", projectId: "p1", name: "command-center", title: "command-center", path: project.path, branch: "", archived: false, scratch: true, ship: true, root: true };
  const state = {
    worktrees: [free, ship],
    chats: [
      { id: "c1", worktreeId: "s" },
      { id: "c2", worktreeId: "ship-command-center" },
      { id: "c3", worktreeId: "ship-command-center", ship: { slug: "x" } },
    ],
  };
  assert.deepEqual(scratchChats(state).map((c) => c.id), ["c1"]);
  assert.deepEqual(homeScopes(state, "p1").map((w) => w.id), ["ship-command-center"]);
  assert.deepEqual(homeScopes(state, "nope"), []);
});
