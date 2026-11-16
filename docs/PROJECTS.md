# Projects

A project is a department's goal-shaped piece of work: a name, what "done"
looks like, a lead, members, dates, milestones and tasks. Tasks stay tasks:
their references, deadlines, overdue reviews and black marks work exactly as
before. A project only groups them and works out its numbers from them.

The plan behind this build is `docs/PROJECTS_TODOS_PLAN.md`. The routes are
in `docs/API.md` under "Projects".

## Who creates, manages and sees what

| Who | Can |
| --- | --- |
| Managers (`project.create`) | create projects in their own department, and manage those |
| Admins and super admins (`project.manage.any`) | create and manage projects in any department |
| A project's lead | manage their own project: details, members, milestones, updates, closing it |
| Members and viewers | work in projects; they do not create them |

These two permissions are the only grants this build added. No one else's
role or permissions changed.

**Who sees a project:**

- everyone with `task.view.all`;
- its owning department;
- its lead and members;
- anyone who is the assignee, follower or a tagged collaborator of a task in it;
- everyone, when it is marked "Everyone in the company".

**Members see every task in their project**, even outside their department.
That one rule was added in one place, `server/src/services/taskAccess.js`,
which is now the only task-visibility rule in the app (Part 0). Removing a
member ends that access everywhere at once: board, workspace, reminders,
Chat and search. Access they have for other reasons stays.

A project's name is shown only to people who can see the project; elsewhere
a task's project shows as hidden.

## How things link (each stored once)

| Relationship | Stored in |
| --- | --- |
| Project → department | `projects.department_id` (required; a department with projects is deactivated, never deleted) |
| Task → project | `tasks.project_id` (at most one) |
| Subtask → project | not stored: a subtask is always in its parent's project |
| Task → milestone | `tasks.milestone_id` (a milestone of the task's own project) |
| Project → key results | `project_key_result_links`: context only, never `TASK_ROLLUP` |
| Project → its origin deal or application | `projects.opportunity_id` |
| Project ↔ CRM delivery record (engagement) | `projects.engagement_id` (one each way) |
| Meeting → project | `crm_meetings.project_id` |
| Project stamp colour | `projects.color` (optional; else the department's) |

Everything else is worked out when read:

- **Progress:** done ÷ (all − cancelled − archived), counting the tasks the
  viewer can see.
- **Overdue count.**
- **Health from the tasks:**
  - "Off track" when the target date has passed, or a milestone is past with
    open tasks;
  - "At risk" when a task is overdue, or a milestone is due within 3 days
    with open tasks;
  - otherwise "On track".
- **Next milestone.**

The lead's own update ("On track / At risk / Off track", with a note) is
shown beside these numbers, never instead of them. Every count equals the
list it opens.

## What happens when something changes

- **A task moves to another project:** its subtasks move with it, and its
  milestone is cleared (the screen says so). Both projects' activity records
  the move. To-dos linked to the task follow by themselves.
- **A task joins a project with a CRM delivery record:** the task's
  `engagement_id` is set if it was empty.
- **A recurring task makes its next occurrence:** the occurrence keeps the
  project, and the milestone if it is not reached. Key result and deal links
  are not carried; that is how recurrence already worked (PD7, below).
- **A project is put on hold:** no task changes. The lead sees the open tasks
  with dates and can move them through the existing deadline-change flow,
  with reasons.
- **A project is completed or cancelled with open tasks:** the lead chooses
  for each task whether to keep it open, move it to another project, or take
  it out of the project. Nothing is closed for them. A completed project takes
  no new tasks until it is reopened.
- **The last open task closes:** the lead is asked "Complete the project?".
  It never completes by itself.
- **A deal is lost:** a linked project is unchanged and shows "Origin deal:
  lost".

## Screens

- **Projects** (navigation, next to the Board): grouped by department, with
  "Mine" and "All I can see", department, status and search. New project is
  shown to people who may create one.
- **A project's page**, with tabs:
  - **Overview:** health, the linked key results, the origin deal and the
    delivery record;
  - **Tasks:** grouped by milestone, with "New task in this project", "Add
    existing tasks" and "Open on the board";
  - **Milestones**, **Updates**, **People**, **Meetings**;
  - **Steps:** shared to-dos, with who and when; project progress still counts
    tasks only;
  - **Activity.**
- **The task dialog** has Project and Milestone fields. Picking a project for
  someone outside it asks "Add them to the project? Members see all its
  tasks." The dialog may also suggest the project's key results; that
  suggestion starts unticked.
- **Board and saved views** have a Project filter, and cards show a project
  chip. **My tasks** can be grouped by project.
- **Overdue review:** "Project" now means real projects. The old grouping of
  a parent task with its subtasks is kept as "Parent task".
- **Starting from what exists** (for people who may create projects). Nothing
  changes until you confirm, references, owners and deadlines never change,
  and both are logged:
  - **"Turn this task and its 2 subtasks into a project…"** in a top-level
    task's Edit details: it previews the project (the task's title, its
    department, its owner as lead) and every task that would join.
  - **"Make a project from a tag"** on Projects: it lists the open tasks you
    can see with the tag; you tick the ones to include, and put them in a new
    project or one that exists. A subtask, or a task already in a project, is
    shown but cannot be ticked.
  - **The undo:** "Take tasks out…" on the project's Tasks tab takes them out
    again (subtasks come with their parent). One task can also be taken out
    by choosing No project in its dialog.
- **CRM:** a won deal or a selected application offers "Start a project"; the
  delivery record links to its project. **Goals:** a key result lists its
  supporting projects.

## In My workspace

- **The My projects widget** is in the Managers, Leadership and Partnerships
  templates, and in the catalogue for everyone. Each project shows your open
  tasks in it, with "No project" last. Leads also see unassigned and overdue
  counts.
- **Needs attention:**
  - for the lead, a milestone due, the project past its target date, an
    update due, or unassigned tasks;
  - for the department's managers (and admins), "Project has no active lead".
- **Reminders, to the lead only:**

  | Reminder | When |
  | --- | --- |
  | Milestone due | 3 days before |
  | Target date | 7 days before |
  | Update due | 14 days after the last update |

  They follow the launch policy, so nothing old is sent. Each person can turn
  them off, and they are cancelled when the reason goes away.

A project's dates never create black marks, overdue reviews or reminders to
anyone but its lead.

## The switch

Settings → Workspace → **Projects** (on by default; people with
`settings.manage`). Off: project fields, widgets and pages are hidden and
the project APIs answer 404. The data is kept, and tasks keep working.

## Not available in this build

- **Project templates** (copying a project's milestones and tasks): PD8, not
  built.
- **The standup review's project label:** P3.6 asked for the task's project
  name next to its reference in the standup review. It was not built.

## Reported, not changed

- **PD7:** a recurring task's next occurrence does not carry its key result
  links or its deal. Carrying them would change how `TASK_ROLLUP` counts, so
  the owner decides.
- **Comments:** `POST /tasks/:id/comments` checks the `task.comment`
  permission, but not whether the person can see the task.
- **Archive and restore:** archiving or restoring a task checks the creator or
  `task.delete`, but not visibility.

## Not verified

- With real Google Chat delivery: the reminder rules were tested through the
  engine and the delivery log, with no message sent to anyone.
- On a real phone: the project pages were checked in phone-sized browser
  windows only.
