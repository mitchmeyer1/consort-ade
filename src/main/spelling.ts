import { execFile } from "node:child_process";

/**
 * macOS marks the misspelling but never fills `params.dictionarySuggestions` — every right-click on a
 * red-underlined word arrives with an empty list (Electron 44). The corrections come instead from the
 * same NSSpellChecker the rest of the system uses, reached through a short JXA call (~60ms, cached).
 */
const GUESSES = `ObjC.import('AppKit');
function run(argv) {
  var word = argv[0], checker = $.NSSpellChecker.sharedSpellChecker;
  var guesses = checker.guessesForWordRangeInStringLanguageInSpellDocumentWithTag($.NSMakeRange(0, word.length), $(word), checker.language, 0);
  var out = [];
  for (var i = 0; i < guesses.count && i < 8; i++) out.push(ObjC.unwrap(guesses.objectAtIndex(i)));
  return JSON.stringify(out);
}`;

const cache = new Map<string, string[]>();

export function spellingSuggestions(word: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (!word || platform !== "darwin") return Promise.resolve([]);
  const cached = cache.get(word);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    // the menu waits on this, so a slow or missing osascript must not hold the click
    execFile("osascript", ["-l", "JavaScript", "-e", GUESSES, word], { timeout: 1500 }, (error, stdout) => {
      let words: string[] = [];
      try { if (!error) words = (JSON.parse(stdout.trim()) as unknown[]).filter((w): w is string => typeof w === "string"); } catch { words = []; }
      if (words.length) cache.set(word, words);
      resolve(words);
    });
  });
}
