# Projects, to-dos and the notebook: the plan

This is the short plan for the build prompt "Projects, quick to-dos and a
notebook-style Today's plan". It records what the code has today, what was
missing or wrong in the prompt's description, and the design choices.

## What the code has (section 3 of the prompt, checked)

| Prompt says | Found | Note |
| --- | --- | --- |
| Visibility rule copied by hand in `taskSummaries.js`, `taskReview.js`, `workspace/access.js` and in `routes/tasks.js` | **Partly wrong.** The rule lives in two places: `visibilityClause`/`canAccess` in `routes/tasks.js`, and `taskVisible` in `workspace/access.js`. | In `taskSummaries.js`, `taskReview.js` and `/tasks/mine`, the matches on `task_collaborators` mean "supporting" or "tagged", not "may see". They stay as they are. |
| Checklist routes check no access | Confirmed (`routes/tasks.js`, end of file) | Fixed in Part 0.2 |
| Recurrence drops key result links and the deal | Confirmed. Both inserts in `services/recurrence.js` list their columns. | `project_id` and an open `milestone_id` are added there (PD7) |
| Departments are deactivated, not deleted, when they have tasks | Confirmed (`routes/departments.js`) | Extended to projects |
| `TASK_REF` would read "PR-12" as a task | Confirmed | Projects have no typed code |
| No modules screen | Confirmed. `crm.enabled` and the like are settings with no switch in the app. | Switches go in Settings → Workspace |
| The service worker keeps one shared copy of API reads, not cleared on sign-out | Confirmed by reading `client/public/sw.js`. Signing out (`state/AppState.jsx`) clears only the workspace's sessionStorage copy. | Part 0.3 writes the test first, then fixes it |
| Roles and permissions | Defined in code (`lib/permissions.js`). Admin and super admin get every key, except super-admin-only ones for admins. | Adding `project.create` to the manager list, and both keys to `PERMISSIONS`, is the whole grant. No data changes. |

**"Project" already means something on one screen.** The overdue review
(`routes/taskReview.js`, `pages/Review.jsx`) filters and groups by
"project", meaning a parent task and its subtasks. Once real projects exist,
that word would mean two things on one screen. In P3, the review's Project
filter and grouping use real projects. The parent-task grouping stays,
renamed "Parent task", and its test is updated to match. This is reported as
a change.

**Found while reading, outside the prompt.** These are reported, not changed:

- `POST /tasks/:id/comments` checks the `task.comment` permission but not
  whether the person can see the task.
- Archiving and restoring a task check the creator or `task.delete`, not
  visibility.

Both belong to the same family as the checklist gap. They are left as they
are and listed in the report.

## Access: one module

`server/src/services/taskAccess.js`:

- `taskVisibilitySql(user, params, alias = 't')` returns the WHERE fragment.
- `canSeeTask(user, taskId)` checks one task with the same fragment.
- `canEditTask(user, task)` is today's `canEdit`.

`routes/tasks.js` keeps `visibilityClause` and `canAccess` as thin
re-exports, so `keyResults.js`, `objectives.js`, `reminders.js`, `threads.js`
and `taskReview.js` keep their imports. `workspace/access.js` calls
`canSeeTask`.

A test runs a matrix of made-up users, tasks and relationships through the
old rule (kept as a copy inside the test) and the module, and expects
identical answers. In P1 the module gains one more path: membership of the
task's project. The test then expects that path to be the only difference.

## Data (additive migrations)

- **`038_projects.sql`**:
  - `projects`, `project_members`, `project_milestones`, `project_updates`,
    `project_key_result_links`, `project_activity`;
  - `tasks.project_id` and `tasks.milestone_id`;
  - `crm_meetings.project_id`;
  - the widened workspace checks (PROJECT entity and the rule keys);
  - indexes.
- **`039_todos.sql`**:
  - `todos`, `todo_lists`, `todo_routines`, `todo_pins`;
  - the step columns on `task_checklist_items`;
  - the TODO entity type.
- **`040_notebook.sql`**:
  - `todo_day_notes`, `todo_moves`;
  - `todos.starred`, `projects.color`;
  - the user notebook preferences.

## Services

- **`services/projects/`**, with one function for each of:
  - the numbers (progress, overdue, health, next milestone);
  - moving a task (subtasks follow, milestone cleared, activity on both
    projects, engagement sync);
  - visibility (through `taskAccess`).
- **`services/todos/`**:
  - one item shape for to-dos, owned steps and pins;
  - counts from the same function as the lists;
  - Chat commands call the same service.

## Screens

- **Projects:**
  - `/projects`, grouped by department;
  - `/projects/:id`, with tabs: Overview, Tasks, Milestones, Updates,
    People, Meetings, Steps, Activity;
  - Project and Milestone in the task dialog;
  - a Project filter and chip on the Board, and in saved views;
  - group by project on My Tasks and the My tasks widget;
  - the My projects widget.
- **To-dos:**
  - `/todos`, the notebook;
  - the header drawer (pocket notebook);
  - the overview card and the workspace widget;
  - Settings → Workspace: the two module switches, and notebook preferences
    in My account.

## Decisions

- **Projects:** PD1–PD9 are settled as written in the prompt. Managers and
  above create projects, and members see every task in their project.
- **To-dos:** TD1–TD15 are the prompt's defaults.
