# Photos and storage (`packages/storage`, `packages/photos`)

- **Upload flow.** `createUploadSession` returns one upload target per declared file (JPEG,
  at most 20 MiB, with its SHA-256). The client PUTs the bytes straight to storage, then
  `addItemPhoto` attaches the file: the server checks that the stored object has the declared
  size and checksum, creates the photo as `processing`, and adds its processing job in the
  same transaction. Targets last 15 minutes (`getUploadSession` returns fresh ones after a
  relaunch); a session lasts 24 hours, and a file is attached at most once.
- **Storage drivers** implement `ObjectStorage`. Both sign the content type, exact size, and
  `x-amz-checksum-sha256` of each upload, so storage itself refuses any other body: S3 with
  presigned PUTs, and the local driver (files in `.local/storage`) with HMAC-signed URLs that
  the API serves under `/storage/`. Keys under `public/` are readable by URL (CloudFront in
  production); every other key is private and never served.
- **Processing** (`processPhoto`, a job function under the task name `photo_processing`)
  verifies the upload's sha256, decodes it with `sharp` (a non-JPEG or broken file makes the
  photo `failed` with a reason the user can read). Only a file that starts like a JPEG reaches
  the decoder, and one larger than 4096 x 4096 pixels is refused, so a small file cannot decode
  into hundreds of megabytes. Then it turns the photo upright and writes, one at a time, metadata-free
  sRGB JPEGs: `original` (full size) and `ai` (1024 px) privately, and `thumbnail` (400 px)
  and `listing` (1600 px) under an unguessable public key. It stores their keys, sizes, and
  hashes in `photo.derivatives`, the upright size, and a 64-bit DCT pHash, then deletes the
  upload, which may carry GPS. In S3, an upload left more than 7 days (never attached) expires. Every step is safe to rerun. The API adds the job to the job
  queue (Graphile Worker, `graphilePhotoJobs`, job key `photoJobKey`) in the transaction that
  attaches the photo, and the worker runs it (`processPhoto`, task `photo_processing`) next to
  the operation steps. Analyses go the same way (`graphileAnalysisJobs`, `analysisJobKey`,
  `runItemAnalysis`, task `item_analysis`). The API and the worker must share photo storage:
  deployed, both use the S3 photo bucket (`infra/src/containers.ts`). Photo and analysis jobs
  run in a pool of their own (`WORKER_TASK_CONCURRENCY`), so a slow AI call never holds a
  slot an operation step, such as an urgent delist, needs.
- **Photo-set hash.** `itemPhotoSet` returns an item's photos in order and `photoSetHash`
  (from `@listora/shared`) over their upload sha256s, the key analysis is idempotent by. The
  hash sorts the sha256s, so reordering the photos or choosing another cover keeps the
  analysis; only adding or removing photos makes a new photo set. The display order reaches
  only the prompt.
- Deleting a photo, its item, or the whole account deletes its stored objects after the transaction commits.

## Data

- **Uploads:** `upload_session` (expiry) and its `upload_file` rows (declared type, size,
  sha256, storage key, and status `pending`, `uploaded`, or `attached`).
