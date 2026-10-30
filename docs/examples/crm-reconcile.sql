-- Sales CRM rollout: counts and fingerprints of the records that existed before
-- the release. Read-only. Run before and after the upgrade and compare the two
-- outputs (docs/CRM_ROLLOUT.md §3.2). The stages the release adds (the CSR
-- pipeline and Approval / Contracting) are left out, so the one expected
-- difference is the "stage positions" line: Won and Lost one place down.
-- Any other difference means stop.
--
--   psql -U postgres -d <database> -f docs/examples/crm-reconcile.sql > before.txt
--
-- The schema is "taskflow"; change the next line if DB_SCHEMA is different.
SET search_path TO taskflow;

SELECT 'accounts' AS what, COUNT(*) AS n,
       md5(COALESCE(string_agg(concat_ws('|', id, name, type, stage_id, owner_user_id, department_id, value, currency, website, segment_id, is_archived, created_at), E'\n' ORDER BY id), '')) AS fingerprint
  FROM accounts
UNION ALL
SELECT 'account_contacts', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, account_id, full_name, email, phone, is_primary), E'\n' ORDER BY id), ''))
  FROM account_contacts
UNION ALL
SELECT 'account_stages (ids, names, kinds)', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, slug, name, kind, default_probability, is_active), E'\n' ORDER BY id), ''))
  FROM account_stages WHERE slug NOT LIKE 'csr-%' AND slug <> 'approval-contracting'
UNION ALL
SELECT 'opportunities', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, account_id, name, stage_id, status, estimated_value, agreed_value, currency, probability, owner_user_id, closed_at), E'\n' ORDER BY id), ''))
  FROM opportunities
UNION ALL
SELECT 'opportunity_contacts', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', opportunity_id, contact_id, role), E'\n' ORDER BY opportunity_id, contact_id), ''))
  FROM opportunity_contacts
UNION ALL
SELECT 'opportunity_history', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, opportunity_id, field, from_value, to_value, created_at), E'\n' ORDER BY id), ''))
  FROM opportunity_history
UNION ALL
SELECT 'account_activities', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, account_id, opportunity_id, type, subject, occurred_at), E'\n' ORDER BY id), ''))
  FROM account_activities
UNION ALL
SELECT 'opportunity_orders', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, opportunity_id, reference, received_on, amount, currency, status), E'\n' ORDER BY id), ''))
  FROM opportunity_orders
UNION ALL
SELECT 'opportunity_invoices', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, opportunity_id, number, issued_on, amount, currency, status), E'\n' ORDER BY id), ''))
  FROM opportunity_invoices
UNION ALL
SELECT 'opportunity_payments', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, opportunity_id, received_on, amount, currency, reference, is_void), E'\n' ORDER BY id), ''))
  FROM opportunity_payments
UNION ALL
SELECT 'tasks', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, ref, title, status_id, assignee_id, due_date, completed_at, account_id, opportunity_id), E'\n' ORDER BY id), ''))
  FROM tasks
UNION ALL
SELECT 'users', COUNT(*),
       md5(COALESCE(string_agg(concat_ws('|', id, email, role, department_id, is_active), E'\n' ORDER BY id), ''))
  FROM users
ORDER BY 1;

-- money totals per currency, as stored
SELECT 'deal values' AS what, currency, COUNT(*) AS deals, SUM(estimated_value) AS estimated, SUM(agreed_value) AS agreed
  FROM opportunities GROUP BY currency ORDER BY currency;
SELECT 'payments' AS what, currency, COUNT(*) AS payments, SUM(amount) FILTER (WHERE NOT is_void) AS received
  FROM opportunity_payments GROUP BY currency ORDER BY currency;

-- stage order (Won and Lost are expected to move one place down)
SELECT 'stage positions' AS what, string_agg(slug || '=' || position, ', ' ORDER BY position, id) AS stages
  FROM account_stages WHERE slug NOT LIKE 'csr-%' AND slug <> 'approval-contracting';
