UPDATE storage.buckets
SET file_size_limit = 524288000
WHERE id = 'bob-uploads';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'bob-uploads') THEN
    RAISE EXCEPTION 'Storage bucket bob-uploads does not exist';
  END IF;
END $$;