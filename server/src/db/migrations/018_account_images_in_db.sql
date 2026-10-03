-- Logos and banners move into the database.
--
-- They were files in UPLOAD_DIR, and a deploy that replaces the checkout took
-- them with it. Each is small, so the bytes now live in the row itself and
-- survive any deploy, backup or move. Existing rows keep stored_name; the
-- server copies each file into `data` the first time it is served (or at
-- start-up) while the file still exists. Additive only.
ALTER TABLE account_images ADD COLUMN IF NOT EXISTS data BYTEA;
