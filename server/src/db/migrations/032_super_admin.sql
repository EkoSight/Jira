-- Super admins: the founders. Every permission, and outside daily work
-- tracking (attendance, check-in, check-out, reminders, the standup).
--
-- Additive only. The role list is widened and keeps every role it allowed
-- before. Nobody is made a super admin here: that is done by name, once, with
-- `npm run access:super-admin -- --grant <email> ...` (see docs/ACCESS.md), so
-- no person's details live in the code. Existing admins stay admins.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'manager', 'member', 'viewer'));
