import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseShipState, sortShip, type ShipBoard, type ShipFeature } from "../shared/ship";

/** the skill resolves everything from the home folder, and must run there for its project skills and settings */
export const SHIP_HOME = join(homedir(), "command-center");
export const SHIP_WORKTREE_ID = "ship-command-center";

const alive = (pidFile: string) => {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
};

/** every feature folder's state.json; folders starting with _ or . are the skill's archive and scratch */
export function readShipBoard(root = join(SHIP_HOME, "pipeline")): ShipBoard {
  if (!existsSync(root)) return { root, features: [], error: `No /ship pipeline at ${root}.` };
  const features: ShipFeature[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const folder = join(root, name);
    try {
      const f = parseShipState(JSON.parse(readFileSync(join(folder, "state.json"), "utf8")), folder, alive(join(folder, "await-review.pid")));
      if (f) features.push(f);
    } catch {}
  }
  return { root, features: sortShip(features) };
}
