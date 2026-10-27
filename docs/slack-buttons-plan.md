# Plan: Slack Reply and Ask buttons on a shared Consort bot

Status: planned, not built. Updated 2026-10-27.

## Setup the plan assumes

- One Slack app, **Consort** (app ID `A0CCGBH65CM`), shared by the whole team. Install is waiting on a workspace admin.
- Each person runs their own consort-cli with the same bot token (`xoxb-…`) and their own Slack member ID: `consort-cli slack set --bot-token xoxb-… --user <member id>`.
- One consort-cli serves one Slack user. It posts only into that user's DM with the bot and publishes only that user's Home tab.
- Today nothing listens for Slack events. Each consort-cli checks its owner's DM threads on a timer (`Slack.waitForReply`, `Slack.threadMessages` in `src/cli/slack.ts`).

## The problem

- Buttons and forms need Slack to tell someone about the click. With Socket Mode, every consort-cli opens a connection to Slack using a shared app-level token (`xapp-…`).
- Slack sends each click to **one** of the open connections, picked at random. It is not sent to the clicker's own consort-cli.
- With five people online, a click reaches the right consort-cli about one time in five.

## The fix: any consort-cli handles any click, then hands the result over in Slack

Every consort-cli handles a click the same way, no matter whose it is:

1. **Click.** Each button carries what's needed in its `value`: the owner's member ID, the DM channel, and the task thread's `ts`. Home tab buttons can only be clicked by the Home tab's owner, so the clicker is always the owner.
2. **Open the form.** The consort-cli that gets the click calls `views.open` with the click's `trigger_id` and has 3 seconds to do it. That works from any consort-cli because they all hold the same bot token. The button `value` is copied into the form's `private_metadata`.
3. **Submit.** The submission also goes to a random consort-cli. That one checks that the submitter is the owner named in `private_metadata`, then posts into the owner's DM:
   - **Reply:** posts the text as a reply in the task thread.
   - **Ask:** posts the text as a new top-level message in the owner's DM.
   - Each post carries Slack message `metadata`: `event_type: consort_relay`, payload `{ user: <submitter id>, kind: "reply" | "ask" }`. The text reads `💬 <@U…> via Reply: …` so it's clear in the thread.
4. **Pick up.** The owner's consort-cli reads the thread on its usual timer, as now. It counts a bot message with `consort_relay` metadata from its owner the same as a message the owner typed.

So nothing has to be passed between computers. Slack itself carries the handoff, and the owner's consort-cli finds it the usual way.

## Code changes

- `src/shared/headless.ts` `replyAfter`: also accept bot messages whose metadata is `consort_relay` with `user` equal to the owner. Today it drops every message with `bot_id`.
- `src/cli/slack.ts`: pass `include_all_metadata: true` to `conversations.replies` and `conversations.history`, and add `metadata` to `SlackThreadMessage`.
- New `src/cli/slackSocket.ts`: one Socket Mode connection per consort-cli (`apps.connections.open` with the `xapp-` token, then a WebSocket). It replies to each event within 3 seconds, opens forms, and posts the relayed text. It reconnects when Slack asks it to.
- `src/cli/slackMonitorBlocks.ts`: add **Reply** to each card, and **Ask** in the header. These replace the current "Reply in thread" / "Open thread" link buttons only where Socket Mode is set up. Without an `xapp-` token, the link buttons stay as now.
- New top-level asks: the owner's consort-cli reads its DM's top-level messages on the timer and turns an `ask` relay into a new task or question. Today it only reads task threads.
- `consort-cli slack set --app-token xapp-…`: stores the app-level token next to the bot token. `consort-cli setup` asks for it as an optional step.
- `docs/slack-app-manifest.json`: set `socket_mode_enabled: true` and turn on `interactivity`. No new bot scopes are needed. The `xapp-` token needs `connections:write`, which is set on the token, not in the manifest.
- `docs/CLI.md` "Slack app": add making the `xapp-` token and sharing it like the bot token.

## Limits to accept

- At least one person's consort-cli must be running for buttons to work. If none are, Slack shows the clicker an error. Typing in the thread always works.
- Slack allows at most 10 open Socket Mode connections per app. More than 10 people online at once would need a small shared server. Not needed now.
- Anyone with the bot token and the `xapp-` token could post or relay as the bot. That's already true of the bot token. Share both like passwords.
- An older consort-cli without this change may get a click and do nothing. Everyone should update before Socket Mode is turned on.

## Steps, in order

1. **Read relayed messages.** Change `replyAfter` and the reads in `slack.ts`. Tests: a `consort_relay` bot message from the owner counts; one naming someone else doesn't; a plain bot message doesn't.
2. **Socket connection.** `slackSocket.ts`, the `--app-token` setting, reconnects. Test against a fake Slack WebSocket.
3. **Reply button and form.** Card button, `views.open`, submission check, relayed post. Test that a click for another owner is handled the same way.
4. **Ask button.** Header button, new-ask pickup from the DM's top level.
5. **Manifest and docs.** Socket Mode and Interactivity on, plus the setup steps in `docs/CLI.md`.
6. **Try it with two people.** Two consort-clis on one bot. Each clicks Reply on their own card 10 times. All 20 answers reach the right task.

## After this: retire the pinned post

- Once the Home tab and buttons work, stop posting and pinning the 📊 dashboard post in each DM (`src/cli/slackMonitor.ts`).
- Delete the old pinned post once. Keep task threads.
- Keep a setting to turn the pinned post back on for anyone who wants it.
