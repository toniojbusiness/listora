-- Photo uploads and the image pipeline (plan task T-07).
--
-- A client asks for an upload session, sends each file's bytes straight to object storage
-- (S3, or the local-disk driver in development), then attaches each file to an item as a
-- photo. The worker then verifies the file, strips its metadata, and derives the images that
-- the app, the AI call, and marketplaces use.

-- One request for upload targets. Its files can be uploaded and attached until it expires.
create table upload_session (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  constraint upload_session_expires_after_creation check (expires_at > created_at)
);

create index upload_session_expires_idx on upload_session (expires_at);

-- One file of a session: what the client declared, and where its bytes go. `uploaded` means
-- the stored object was checked against the declared size and SHA-256; `attached` means a
-- photo uses it (a file is attached at most once).
create table upload_file (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  session_id uuid not null,
  -- The file's index in the session request.
  position integer not null check (position >= 0),
  -- The pipeline decodes JPEG only (the libvips build sharp ships cannot read HEVC/HEIC).
  content_type text not null check (content_type in ('image/jpeg')),
  -- At most 20 MiB, the contract's limit.
  byte_size integer not null check (byte_size between 1 and 20971520),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text not null unique check (char_length(storage_key) between 1 and 1024),
  status text not null default 'pending' check (status in ('pending', 'uploaded', 'attached')),
  uploaded_at timestamptz,
  attached_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (session_id, position),
  foreign key (account_id, session_id) references upload_session (account_id, id) on delete cascade,
  constraint upload_file_uploaded_at_iff_not_pending
    check ((status = 'pending') = (uploaded_at is null)),
  constraint upload_file_attached_at_iff_attached
    check ((status = 'attached') = (attached_at is not null))
);

create trigger upload_session_set_updated_at before update on upload_session
  for each row execute function set_updated_at();
create trigger upload_file_set_updated_at before update on upload_file
  for each row execute function set_updated_at();

-- A photo is `processing` from the moment it is attached until the worker has made its derived
-- images (`ready`) or found that the file is not a usable image (`failed`, with a reason the
-- user can read). `storage_key` stays the key the client uploaded to; the worker deletes that
-- object once the photo is processed, because it may still carry GPS and other metadata.
-- `derivatives` then holds the metadata-free images: `original` (full size, private), `ai`
-- (1024 px, private), and `thumbnail` (400 px) and `listing` (1600 px), which are public.
alter table photo
  add column status text not null default 'processing'
    check (status in ('processing', 'ready', 'failed')),
  add column failure_reason text check (char_length(failure_reason) between 1 and 500),
  add column processed_at timestamptz,
  add constraint photo_failure_reason_iff_failed
    check ((status = 'failed') = (failure_reason is not null)),
  add constraint photo_processed_at_iff_processed
    check ((status = 'processing') = (processed_at is null)),
  add constraint photo_ready_has_images
    check (
      status <> 'ready'
      or (
        width is not null and height is not null and sha256 is not null and phash is not null
        and derivatives ?& array['original', 'ai', 'thumbnail', 'listing']
      )
    );
