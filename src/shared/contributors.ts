/** Who a branch's work belongs to: whoever authored the most commits on it. */

export type Commit = { name: string; email: string };
export type Contributor = { name: string; login?: string; commits: number };

/** GitHub hands out "12345+login@users.noreply.github.com" (and older "login@…"), the one place a commit carries a login */
export function githubLogin(email: string) {
  const match = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/i.exec(email.trim());
  return match ? match[1] : undefined;
}

export function topContributor(commits: Commit[]): Contributor | undefined {
  const byPerson = new Map<string, Contributor>();
  for (const { name, email } of commits) {
    const login = githubLogin(email);
    // one person, one entry: their login if we know it, otherwise their email
    const key = (login ?? email.trim().toLowerCase()) || name;
    if (!key) continue;
    const seen = byPerson.get(key);
    if (seen) { seen.commits++; seen.login ??= login; }
    else byPerson.set(key, { name: name.trim() || login || key, login, commits: 1 });
  }
  // ties keep the person seen first, which git log orders newest-commit-first
  return [...byPerson.values()].reduce<Contributor | undefined>((best, c) => (!best || c.commits > best.commits ? c : best), undefined);
}
