-- Pending Christian approval. Do NOT apply as part of PR #16 development.
-- Private objects accessed only via authenticated Havo server routes; no public
-- or authenticated storage policy grants direct access. Supabase storage.objects
-- already has RLS. Service-role server prefixes every object with verified user UUID.
BEGIN;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('private-wind-reports','private-wind-reports',false,8388608,
        ARRAY['application/pdf','image/png','image/jpeg'])
ON CONFLICT(id) DO NOTHING;
-- Restrictive policies ensure broad policies for other buckets cannot expose
-- these files. Server service_role bypasses RLS; routes enforce owner isolation.
CREATE POLICY wind_reports_no_client_access ON storage.objects
AS RESTRICTIVE FOR ALL TO anon,authenticated
USING (bucket_id <> 'private-wind-reports')
WITH CHECK (bucket_id <> 'private-wind-reports');
COMMIT;
