-- Repair goal periods that were stored a day early.
--
-- periodPresets() built its dates with toISOString(), which converts to UTC
-- first, so local midnight anywhere east of Greenwich landed on the previous
-- day. A goal set with the "This quarter" button in IST was saved as
-- 30 Jun – 29 Sep instead of 1 Jul – 30 Sep. The preset code is fixed; this
-- repairs the rows it already wrote.
--
-- DELIBERATELY NARROW. A row is only touched when shifting it forward one day
-- turns it into an exact calendar quarter, half or year — the fingerprint the
-- bug leaves and nothing else produces. A period that is already correct does
-- not match (its start is the 1st, so start + 1 is the 2nd). A hand-typed
-- period does not match unless it happens to be exactly one day before a real
-- quarter at both ends, in which case the shift is what was meant anyway.
--
-- Nothing is deleted and no column changes. Every adjustment is written to
-- okr_activity, so it shows in each goal's own History rather than happening
-- silently underneath people who have been checking in against it.

-- ---------------------------------------------------------------- objectives

CREATE TEMP TABLE okr_period_repairs ON COMMIT DROP AS
SELECT o.id,
       o.start_date        AS old_start,
       o.end_date          AS old_end,
       (o.start_date + 1)  AS new_start,
       (o.end_date + 1)    AS new_end
  FROM objectives o
 WHERE o.start_date IS NOT NULL
   AND o.end_date IS NOT NULL
   AND (
        -- a calendar quarter: 1 Jan–31 Mar, 1 Apr–30 Jun, 1 Jul–30 Sep, 1 Oct–31 Dec
        (    (o.start_date + 1) = date_trunc('quarter', (o.start_date + 1)::timestamp)::date
         AND (o.end_date + 1)   = (date_trunc('quarter', (o.start_date + 1)::timestamp)
                                   + interval '3 months' - interval '1 day')::date)
     OR -- a calendar half: 1 Jan–30 Jun, 1 Jul–31 Dec
        (    EXTRACT(DAY FROM (o.start_date + 1)) = 1
         AND EXTRACT(MONTH FROM (o.start_date + 1)) IN (1, 7)
         AND (o.end_date + 1)   = ((o.start_date + 1)::timestamp
                                   + interval '6 months' - interval '1 day')::date)
     OR -- a calendar year: 1 Jan–31 Dec
        (    (o.start_date + 1) = date_trunc('year', (o.start_date + 1)::timestamp)::date
         AND (o.end_date + 1)   = (date_trunc('year', (o.start_date + 1)::timestamp)
                                   + interval '1 year' - interval '1 day')::date)
   );

UPDATE objectives o
   SET start_date = r.new_start,
       end_date   = r.new_end,
       updated_at = now()
  FROM okr_period_repairs r
 WHERE o.id = r.id;

INSERT INTO okr_activity (entity_type, entity_id, actor_id, action, field, from_value, to_value, meta)
SELECT 'OBJECTIVE',
       r.id,
       NULL,
       'period_corrected',
       'period',
       r.old_start::text || ' → ' || r.old_end::text,
       r.new_start::text || ' → ' || r.new_end::text,
       jsonb_build_object(
         'reason', 'the period presets were a day early outside UTC; corrected to the real quarter',
         'old_start', r.old_start::text, 'old_end', r.old_end::text,
         'new_start', r.new_start::text, 'new_end', r.new_end::text
       )
  FROM okr_period_repairs r;

-- ---------------------------------------------------------------- key results

-- Key results normally inherit the objective's period and leave these NULL, so
-- this is usually a no-op. It is here so a key result that was given its own
-- preset period is repaired the same way rather than left contradicting its goal.

CREATE TEMP TABLE kr_period_repairs ON COMMIT DROP AS
SELECT k.id,
       k.start_date       AS old_start,
       k.end_date         AS old_end,
       (k.start_date + 1) AS new_start,
       (k.end_date + 1)   AS new_end
  FROM key_results k
 WHERE k.start_date IS NOT NULL
   AND k.end_date IS NOT NULL
   AND (
        (    (k.start_date + 1) = date_trunc('quarter', (k.start_date + 1)::timestamp)::date
         AND (k.end_date + 1)   = (date_trunc('quarter', (k.start_date + 1)::timestamp)
                                   + interval '3 months' - interval '1 day')::date)
     OR (    EXTRACT(DAY FROM (k.start_date + 1)) = 1
         AND EXTRACT(MONTH FROM (k.start_date + 1)) IN (1, 7)
         AND (k.end_date + 1)   = ((k.start_date + 1)::timestamp
                                   + interval '6 months' - interval '1 day')::date)
     OR (    (k.start_date + 1) = date_trunc('year', (k.start_date + 1)::timestamp)::date
         AND (k.end_date + 1)   = (date_trunc('year', (k.start_date + 1)::timestamp)
                                   + interval '1 year' - interval '1 day')::date)
   );

UPDATE key_results k
   SET start_date = r.new_start,
       end_date   = r.new_end,
       updated_at = now()
  FROM kr_period_repairs r
 WHERE k.id = r.id;

INSERT INTO okr_activity (entity_type, entity_id, actor_id, action, field, from_value, to_value, meta)
SELECT 'KEY_RESULT',
       r.id,
       NULL,
       'period_corrected',
       'period',
       r.old_start::text || ' → ' || r.old_end::text,
       r.new_start::text || ' → ' || r.new_end::text,
       jsonb_build_object('reason', 'the period presets were a day early outside UTC')
  FROM kr_period_repairs r;
