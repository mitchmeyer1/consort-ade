import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/**
 * The right-click menu for text. Electron turns the spellchecker on but never draws a menu for it:
 * without this, a red-underlined word in the composer has no way to be corrected, and Cut/Copy/Paste
 * have no menu either. Kept pure so the ordering and the enabled states can be checked without a window.
 */
export type EditMenuActions = {
  replace: (word: string) => void;
  addToDictionary: (word: string) => void;
};

/** how many of the spellchecker's guesses to show; macOS shows a similar handful */
const SUGGESTIONS = 5;

export function editMenuTemplate(
  params: Pick<ContextMenuParams, "misspelledWord" | "isEditable" | "selectionText" | "editFlags">,
  /** Chromium's guesses where it makes them, the system spellchecker's on macOS */
  dictionarySuggestions: string[],
  actions: EditMenuActions,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const flags = params.editFlags;
  if (params.misspelledWord) {
    const suggestions = dictionarySuggestions.slice(0, SUGGESTIONS);
    if (suggestions.length) template.push(...suggestions.map((word) => ({ label: word, click: () => actions.replace(word) })));
    else template.push({ label: "No Guesses Found", enabled: false });
    template.push({ type: "separator" }, { label: "Add to Dictionary", click: () => actions.addToDictionary(params.misspelledWord) }, { type: "separator" });
  }
  if (params.isEditable || params.selectionText) {
    template.push(
      { role: "cut", enabled: !!params.isEditable && !!flags?.canCut },
      { role: "copy", enabled: !!flags?.canCopy },
      { role: "paste", enabled: !!params.isEditable && !!flags?.canPaste },
      { role: "selectAll", enabled: flags?.canSelectAll !== false },
    );
  }
  // a menu of nothing but separators is worse than no menu at all
  return template.some((item) => item.type !== "separator") ? trimSeparators(template) : [];
}

const trimSeparators = (template: MenuItemConstructorOptions[]) =>
  template.filter((item, i) => item.type !== "separator" || (i > 0 && i < template.length - 1 && template[i - 1].type !== "separator"));
