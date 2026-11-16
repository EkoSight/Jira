# To-dos and the notebook

Quick lines for yourself, written like a paper planner: one line, Enter,
done. A to-do has no deadline machinery. It is never "overdue", and never
feeds black marks, overdue reviews, deadline health, standup reviews,
attendance, payroll, reports, key result values or `TASK_ROLLUP`. Ticking a
to-do never completes a task, and completing every task never completes a
project; both only ask.

The routes are in `docs/API.md` under "To-dos".

## Who sees what

| Thing | Who sees it |
| --- | --- |
| A to-do, a list, a routine, a pin, a day's notes | **only its owner**: not their manager, an admin or a super admin. Another person's id answers 404 from every route |
| A to-do linked privately to a record | its owner. The owner sees the record's name on the line, and "My private to-dos (2)" on the record's page |
| A to-do shared onto a record | everyone who can already see that record, in its **Steps** section: title, who, and when; never the note |
| A step (a task's checklist item) | as its task |

Before anything is shared, the screen says who will see it, for example
"People who can see Project Sample Seed Grant 2027 will see this." Sharing
is always an explicit tap. To unshare, the creator or owner takes the line
back to private, and the record's activity keeps "removed a step".

## How a to-do links (in plain words)

A to-do can point at **one** record: a task, a project, a key result, an
objective, a deal, an application or a meeting. Everything else follows
from that record and is worked out when read, never stored:

- the task's project, and that project's department;
- the task's own department;
- the key results of the task (or of its parent tasks), and their
  objectives;
- the project's key results.

So if a task moves to another project, its to-dos move with it, and the
to-do itself is not changed.

**Links are made in three ways:**

- **From where you write it.** On a project, goal, deal, application or
  meeting page, the box adds a shared step there, and says so. On a task, the
  checklist is the place for shared steps.
- **From a task reference you type.** "WS-12 send the budget annex" links
  privately to WS-12, but only if you can see WS-12. Otherwise it is saved
  unlinked, with "No task WS-12 you can see". The reference is shown as a
  chip you can remove before saving. No dates are ever guessed from the
  words.
- **From a suggestion.** An unlinked line may show one suggestion: a plain
  word match against your own open tasks, projects, key results, deals,
  applications and today's meetings. It needs two shared words, or one word
  of six letters or more, and a tie suggests nothing. Nothing is linked
  until you tap it.

**What counts where.**

- **A task:** shared steps count in its checklist progress, and nothing else
  changes. When every step is done, the assignee is asked "Complete WS-12?".
- **A project:** a Steps tab, and "Steps done 3/5" shown apart. Progress
  counts tasks only.
- **A key result or objective:** a "Steps done" list beside the updates.
  While updating a key result, the steps done since the last update show as
  context. The value is never changed.
- **A deal, application or meeting:** a Steps section, with its own step
  history. This history is kept apart from the CRM's activity table on
  purpose, because sales reports count that table.
- **"What I did"** (Done view) groups your done lines by project, task, goal,
  department and record, for your own updates. Nobody else sees it.

**"Make it a task"** opens the normal New task dialog, pre-filled:

- the words become the title, and the line's day the deadline (at 18:00, or
  at the line's time when it has one);
- a project link puts the task in that project;
- a key result link links the task to it;
- a deal or application link puts the task on it;
- a task link makes it a subtask.

The normal rules apply. On save, the line shows "Became WS-40".

## Steps

A step is a task's checklist item, and the same row is used everywhere.

- **Owner, day and time:** a step can have an owner (the assignee or a
  collaborator), a day and a time.
- **In your plan:** a step you own appears in your Today's plan on its day.
  With no day it appears on the task's due date; when the task has no due
  date, it is in Someday.
- **Ticking:** ticking it anywhere records who and when, and writes a line in
  the task's activity.
- **Old steps:** steps ticked before this build show "done (date not
  recorded)". No date is ever invented.
- **Recurring tasks** carry steps forward unticked, with their owners and
  times.
- **Losing access:** if you can no longer see the task, its steps leave your
  plan. They stay on the task.

## Today's plan

From top to bottom:

1. **Carried over:** unfinished lines from earlier days, on a sticky note,
   labelled "From Fri 13 Nov".
   - Each line offers Today, Tomorrow, Move to… and Remove.
   - They are never called overdue.
   - After 7 days you are asked, once, "Still want this?".
2. **Today:** your to-dos, steps and pinned tasks.
   - Timed lines come first, by time, then the rest in your own order (Move
     up and Move down, announced to screen readers).
3. **Fixed times:** today's meetings you are in. They are read-only.
4. **Done:** ticked lines stay where they were, struck through, with a count.
   "Hide done" folds them away; it is a personal switch.

"Today" is your own timezone, or the company's if you have none. The header's
"3 left" is the plan's own count.

**Plan my day** suggests the following. Nothing is added unless you choose
it.

- your tasks due today, overdue, or due within 2 days;
- your steps planned for other days;
- milestones of your projects due this week, with your open tasks in them;
- today's meetings.

Adding a task **pins** it. A pin is not a copy: it shows the task's live
status. "Complete…" opens the normal completion dialog, and unpinning changes
nothing on the task.

**Other views:**

- **Week**, with "Next 14 days";
- **Someday** (lines with no day);
- **Lists:**
  - personal checklists, which can be linked as a whole, and their items
    follow that link;
  - "Use again" copies a list with every item unticked;
- **Past pages:** the Done view, which you can search, plus the month index.

## Where to-dos appear

| Place | What it does |
| --- | --- |
| **Header, every page** | The To-dos button with today's count ("3 left") opens the pocket notebook. **Alt+N** (Option+N on a Mac) opens it with the empty line ready. It never fires while you are typing in a field. On a phone the button sits in the top bar. |
| **Navigation** | To-dos, at `/todos` |
| **Classic home** | A page snippet at the top: the header, the first lines, an empty line to write on, and "Open notebook" |
| **My workspace** | The Today's plan widget sits at the top of every template. People who had saved their own layout are asked once, "Add Today's plan to your workspace?" (Add or No thanks), and the answer is remembered. A saved layout is never changed without that answer. |
| **Google Chat** | See below |
| **Morning summary** | "Today's plan: 4 to-dos (1 carried over)": a count, never the words. It goes only in the summary that person already receives |
| **Standup** | "Use today's plan" fills the form from to-dos and steps linked to tasks: the reference, the line as the action, the target left for you to write, and "by" the line's time. Nothing is posted until Submit, and the checker is unchanged |
| **App shortcut** | "Add a to-do" in the installed app's shortcuts (`/todos?add=1`) |
| **Remind me** | A private reminder on a to-do, at a time you choose, through the same personal reminders as everywhere. Ticking or removing the line cancels it, and "Move it" plans it again at the new time. Moving the line to another day does not move the reminder. Off unless set |

## Google Chat (direct message with TaskFlow)

| Command | Does |
| --- | --- |
| `todo <words>` or `+ <words>` | Adds a private to-do for today, and replies with the count and "Reply `undo` to take it back" |
| `todos` | Today's plan, numbered (open lines only) |
| `done 2` | Ticks line 2 of that same list, and names it. A pinned task is not ticked from Chat: tasks are completed in TaskFlow, with their outcome |
| `undo` | Reverts the last to-do change made from Chat (one step) |

A message delivered twice acts once. An add uses the message's own name as
its client key, and a tick or undo remembers the message it came from.
`tasks`, `summary`, `today`, `stop`, `start` and `standup …` are unchanged,
and the Chat help lists the new commands.

## Routines (repeating to-dos)

- **Repeat options:**
  - every working day;
  - weekly on chosen days;
  - monthly on a date (the month's last day when the month is shorter).
- **Working days only:** items appear only on your own working days. Never on
  your weekly off, a holiday that covers you, or approved full-day leave
  (from the attendance calendar).
- **Once a day, no backfill:** one item a day, made at the start of your day.
  Reruns make nothing more, and days missed while the server was down are
  not filled in.
- **Changes:** editing a routine changes future items only. Stopping it keeps
  every item it made.
- **Not for shared work:** a routine that others must tick, or a manager must
  see, should be a recurring task with steps. The Repeat dialog says so.

## The notebook

`/todos` is a paper notebook over real controls:

- every line is a real list item, with a real checkbox (labelled with its
  words) and a real text field;
- so screen readers, the keyboard, spellcheck and a stylus's own
  handwriting-to-text all work;
- nothing is drawn on a canvas.

**The page:**

- **The paper:** ruled lines and a margin rule. One rhythm sets both the text
  line height and the rule spacing, so text sits on the lines at any zoom or
  text size.
- **The header:** the date written large, the week number, and a "Today"
  ribbon on today's page.
- **The lines:**
  - each line has a hand-drawn box and a pen tick;
  - a done line gets a slightly uneven pencil line through it;
  - a star is a highlighter mark;
  - the stamp on the right names the task or project, in its colour;
  - a fixed time sits in the margin.
- **Writing:** the next empty line is always ready. Write, press Enter, and
  the next one is ready. Pasting several lines asks once.
- **What else appears:**
  - lines carried over sit on a sticky note;
  - pinned tasks have a paper clip;
  - a line moved to another day stays on its old page, greyed, with "→ Mon
    16 Nov".
- **Notes:** a free notes area for each day. It is private and saves as you
  type, and "Make this line a to-do" keeps the line in the note.

**Margin signs:**

- • open;
- × done;
- → moved to another day;
- ○ a fixed time.

They have words for screen readers, and Signs and shortcuts explains them.

**Tabs on the page edge:**

- Today;
- Week (a two-page spread: Monday to Wednesday, then Thursday to Sunday and
  the notes);
- Someday;
- your 6 most recent lists, then More lists;
- Past pages.

A bookmark ribbon returns to today.

**Turning pages:**

- the previous and next buttons;
- a swipe, but not one that starts within 24 px of the screen edge (that is
  the phone's own back gesture), and not while selecting text;
- **Alt+,** and **Alt+.** on a keyboard.

The animation moves and fades only, and is instant with reduced motion.

**Past pages:** any day, as it was left: what was planned, what was done,
and what moved, with its date. Looking at a page changes nothing. Ticking an
old line records when it was really done.

**Month index:** a small calendar with a dot on days that have lines.

**Print this page / Print this week:** a black-and-white planner sheet. Each
fits one A4 portrait page in the walk-through.

**Layouts**, by the space the notebook is given (container queries):

| Width | Layout |
| --- | --- |
| under 600 px | One page; the tabs as a bottom bar; 44 px lines for fingers; the meetings as a strip under the header; swipe between days; the line being written stays above the on-screen keyboard |
| 600–899 px | One large page, with the tabs on its edge |
| 900–1279 px | A two-page spread; the right page shows your choice of notes, the week at a glance, or a list |
| 1280 px and wider | The spread, plus the time column and the month index; from 1600 px it keeps a comfortable size, centred on a plain desk |

**Feel:**

- **Everything shows at once** and saves in the background, with its client
  key. There are no Save buttons.
- **A failed save** shows "Not saved · Retry" on the line and keeps the text.
  A retry never makes a duplicate.
- **Undo:** Ctrl+Z (⌘Z on a Mac), or the Undo button, for the last 20
  changes. It never fires while you are typing in a field.
- **A light tap on tick:** optional, on phones that support it, and off by
  default. No sounds are ever played.

**Look:**

- light paper, and a dark "night paper" designed on its own;
- forced-colours (high contrast) mode drops the paper effects and keeps plain
  lines and real checkboxes;
- headings and margins use Patrick Hand, a handwriting font under the SIL
  Open Font License (Latin subset, bundled at
  `client/public/fonts/patrick-hand/` with `OFL.txt`);
- "Write my items in handwriting style" is a personal setting, off by
  default.

**Shortcuts:**

| Keys | Does |
| --- | --- |
| Alt+N | Open the pocket notebook with the empty line ready |
| Alt+, / Alt+. | Turn to the previous / next day |
| Enter (on a line) | Start the next line |
| Ctrl+Z / ⌘Z | Undo, up to 20 changes |

None of them fires while you are typing in a field. TaskFlow has no general
Help page, so they are listed in the notebook's "Signs and shortcuts" and on
the To-dos button's tooltip.

## Offline

- **What works offline:** today's page and the pocket notebook. You can add,
  tick, untick, edit words, star and write notes.
- **Kept on this device:** in IndexedDB, one database per signed-in person,
  and sent once, in order, with their client keys when the connection is
  back.
- **Honest status:** until the server confirms, the page says "Saved on this
  device · will sync".
- **Conflicts:**
  - a line deleted on another device: your offline change to it is dropped,
    with a notice;
  - words changed on two devices: the later change wins, and the page says
    "Changed on another device · showing the latest".
- **Signing out** clears the notebook's device data, as well as the service
  worker's copies.

Other pages (the week, lists, past pages) need a connection, and say so.

## The switch

Settings → Workspace → **To-dos** (on by default). Off hides:

- the header button;
- the navigation entry;
- the card and the widget;
- the standup button.

The to-do APIs answer 404, and the data is kept.

## Not available in this build

- Email or push for to-dos (reminders go in the app, and in Chat for people
  who use it).
- Offline beyond today's page and the pocket notebook.
- Freehand drawing (TD11). A stylus works through the device's own
  handwriting-to-text.
- Project templates (PD8).
- The Android app's "Add a to-do" shortcut. The Capacitor app has no shortcut
  set-up, so it needs native work. The installed web app has it.

## Not verified

- **The on-screen keyboard:** that the line being written stays above it was
  only emulated in a browser, not checked on a real phone.
- **A stylus's handwriting-to-text** (Scribble, Android stylus input): not
  tried on a device. The lines are ordinary text fields.
- **Haptics:** `navigator.vibrate` is called when you turn it on, but no
  device was available to feel it.
- **Google Chat delivery:** the commands were tested by sending made-up Chat
  events to the handler. No message was sent to anyone.
- **The morning summary line:** tested in the summary text; it was not
  delivered through Chat.
