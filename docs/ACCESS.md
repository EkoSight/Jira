# Roles and access

Highest first:

| Role | Who | What they can do |
|---|---|---|
| **Super admin** | The founders | Everything, always. No permission can be taken away from them, so they can never be locked out. Outside daily work tracking (see below). |
| **Admin** | Runs TaskFlow day to day | Everything except the powers kept for super admins. Can manage anyone below admin. |
| Manager | Runs a team | Assigns work, adds people, waives black marks, approves leave for their teams |
| Member | Everyone else | Works on their own cards |
| Viewer | Read only | |

Extra permissions can still be given to, or taken from, one person on the Team
page. A super admin can do this for an admin too.

## Kept for super admins

An admin does not have these:

- **Approve and lock payroll months** (`payroll.approve`)
- **Reopen a locked payroll month** (`payroll.reopen`)
- **Record and change salary amounts** (`payroll.salary.edit`)

Only a super admin can hand any of them to a named person, for example to
someone in accounts. It is done on the Team page, as an extra permission, and
the change is recorded.

The list is in `server/src/lib/permissions.js` (`SUPER_ADMIN_ONLY`). Moving a
power on or off the list is a one-line change.

## Who may change whose account

- **Account changes need a higher role.** Changing someone's role or
  permissions, their sign-in email or password, or switching them off is only
  for someone ranked above them. A super admin may do all of this for anyone,
  including the other super admin. One result: a manager can no longer reset
  an admin's password.
- **Only super admins create admins.** Only a super admin can make someone an
  admin or a super admin.
- **A super admin's record is closed to admins.** An admin cannot change it at
  all, not even the job title.
- **Nobody changes their own role or permissions.** Ask another administrator.
- **There is always someone in charge.** At least one active super admin and
  one active administrator always remain.
- **Every change is recorded.** Changes to role, permissions or active status
  go to the audit trail, with who made them, before and after.

## Super admins and daily work

Super admins are not part of daily work tracking:

- **Attendance:** they are never asked to check in. Nothing in TaskFlow is
  blocked for them, and check-in and check-out are refused, so no attendance
  record is ever made for them.
- **Reminders:** no check-in or check-out reminders, by app or by Chat.
- **Team views:** they are not listed in team attendance, the review queue or
  the attendance export.
- **Payroll:** there is no attendance-based payroll month for them. Each payroll
  month lists them as left out, with the reason, so nobody disappears silently.
- **Daily standup:** they are never expected and never chased. They can still
  post one, and can be the people unresolved standups go to.
- **Holidays:** they are still told about holidays. A holiday's attendance
  impact leaves them out.

Everything else is unchanged: tasks and black marks, leave approvals, reports
and settings.

## Making the founders super admins

There are two ways. No person is named in the code either way.

**In the app (no server access needed).** While there is no super admin at
all, every admin sees a card on the Dashboard and under **Settings → My
account**: "There is no super admin yet". A founder enters their own password
and clicks **Make me a super admin**.

- It takes effect at once, in the same session.
- Every other admin is notified, and the change goes to the audit trail.
- It works only once: as soon as anyone is a super admin, the card is gone.
- That first founder then makes the other founder a super admin on the
  **Team** page: Edit → Role → Super admin.
- Before super admins existed, every admin already had every power, so the
  card gives an admin nothing they could not already do. Founders should claim
  it straight after the update.

**On the server.** Use the founders' sign-in emails:

```
npm run access:super-admin                                   # list admins and super admins
npm run access:super-admin -- --grant <email> <email>        # make these accounts super admins
npm run access:super-admin -- --revoke <email>               # back to admin
```

- Run it after the migration that adds the role (`npm run migrate`).
- Each account must already exist and be active. If any email is unknown or
  switched off, nothing changes.
- Running it again changes nothing.
- The people changed are signed out once, so their new role takes effect at
  their next sign-in.
- Each change goes to the audit trail as made from the command line.

After that, a super admin can make or unmake super admins on the Team page.

**Until one of these is done, nobody can approve payroll.** Every admin loses
the kept powers when this release is deployed. `npm run doctor` warns while no
super admin exists.
