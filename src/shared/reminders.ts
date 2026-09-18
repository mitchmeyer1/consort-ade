/** "remind me": a chat you park until a chosen time, then it goes purple and says so */

export type ReminderChoice = { id: string; label: string; due: (now: number) => number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** next 9am, local time */
export function tomorrowMorning(now: number) {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at.getTime();
}

export const REMINDER_CHOICES: ReminderChoice[] = [
  { id: "now", label: "Now", due: (now) => now },
  { id: "30m", label: "In 30 minutes", due: (now) => now + 30 * MINUTE },
  { id: "1h", label: "In 1 hour", due: (now) => now + HOUR },
  { id: "3h", label: "In 3 hours", due: (now) => now + 3 * HOUR },
  { id: "6h", label: "In 6 hours", due: (now) => now + 6 * HOUR },
  { id: "tomorrow", label: "Tomorrow, 9:00 AM", due: tomorrowMorning },
];

/** a reminder whose time has come is "due"; before that it waits, shown as a clock */
export const reminderDue = (remindAt: number | undefined, now: number) => remindAt !== undefined && remindAt <= now;

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** what the dot's tooltip says: when it lands, or how long it has been waiting for you */
export function reminderLabel(remindAt: number, now: number) {
  if (reminderDue(remindAt, now)) {
    const mins = Math.round((now - remindAt) / MINUTE);
    return mins < 1 ? "Reminder · just now"
      : mins < 60 ? `Reminder · ${mins}m ago`
      : mins < 1440 ? `Reminder · ${Math.round(mins / 60)}h ago`
      : `Reminder · ${Math.round(mins / 1440)}d ago`;
  }
  const mins = Math.round((remindAt - now) / MINUTE);
  const when = sameDay(remindAt, now) ? clock(remindAt) : `tomorrow at ${clock(remindAt)}`;
  return mins < 60 ? `Reminder in ${Math.max(mins, 1)}m · ${when}` : `Reminder at ${when}`;
}
