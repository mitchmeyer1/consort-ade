/** Review chats are named for the pull request and whose work it is, never from the first message. */
export function prChatName(pr: { number: number; author?: string } | undefined, fallback: string) {
  if (!pr) return fallback;
  const author = pr.author?.trim();
  return author ? `PR #${pr.number} ${author}` : `PR #${pr.number}`;
}
