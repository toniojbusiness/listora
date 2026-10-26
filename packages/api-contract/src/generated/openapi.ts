/**
 * Generated from packages/api-contract/openapi.yaml by openapi-typescript.
 * Do not edit: change openapi.yaml and run `npm run contract:generate`.
 */

export interface paths {
    "/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Liveness probe
         * @description The process is up. Checks no dependencies.
         */
        get: operations["getLiveness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Readiness probe
         * @description The process can serve traffic (the database answers). Never includes error details.
         */
        get: operations["getReadiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/account": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete my account
         * @description In-app account deletion (App Store Review Guideline 5.1.1(v)). Deletes the signed-in
         *     person and, when they own their account, the account with all of its data: items,
         *     photos, listing records, sales, and history. Live listings themselves stay on the
         *     marketplaces.
         *
         *     A success means the deletion is committed and final: the data is gone, and the bearer
         *     token stops working at once (any other token issued before the deletion too). Listora
         *     then finishes on its own, whether or not the app is still running: it deletes the
         *     person from the sign-in provider, so they cannot sign in to the deleted account again,
         *     and asks each connected marketplace to revoke its access, retrying for up to 7 days.
         *     Until the sign-in provider has deleted the person, signing in again is refused; after
         *     that, it creates a new, empty account.
         *
         *     Any error, including a retryable `500` or `503`, means nothing was deleted; retry with
         *     the same token. A retry after a lost success response gets `401 unauthenticated`, which
         *     means the account is gone.
         *
         *     `marketplaceAccess` reports each API marketplace connection honestly, by marketplace and
         *     the seller's name there: `revoked` is true only when the marketplace had confirmed it
         *     before the deletion. Every entry with `revoked: false` names a marketplace whose access
         *     the user must revoke manually: Listora keeps asking that marketplace (it keeps the
         *     encrypted tokens only for that, and deletes them once the marketplace confirms or after
         *     7 days), but the app cannot learn the outcome, so it lists these marketplaces and tells
         *     the user to remove Listora in each one's connected-apps settings.
         */
        delete: operations["deleteAccount"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List items
         * @description Newest first. Filters combine with AND.
         */
        get: operations["listItems"];
        put?: never;
        /**
         * Create an item
         * @description Creates a `draft` item and allocates its SKU (for example `AJ-000184`) in the same
         *     transaction. Every detail is optional so a draft can be created before analysis.
         */
        post: operations["createItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        /**
         * Get an item
         * @description The item with its photos and per-marketplace listings.
         */
        get: operations["getItem"];
        /**
         * Replace an item's details
         * @description Full replacement of the user-editable `details`: a property left out is cleared.
         *     `expectedVersion` must equal the item's current `version`, otherwise the server
         *     answers `409 version_conflict` and the client refetches. Changing details never
         *     changes a live marketplace listing; use the listing actions for that.
         */
        put: operations["replaceItem"];
        post?: never;
        /**
         * Delete an item
         * @description Allowed only while no listing is live on a marketplace (every listing is `draft` or
         *     `ended`); otherwise `409 invalid_state_transition`. The SKU is never reused.
         */
        delete: operations["deleteItem"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skus/{sku}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The item's SKU, for example `AJ-000184` (from a scanned label). */
                sku: components["schemas"]["Sku"];
            };
            cookie?: never;
        };
        /** Look up an item by SKU */
        get: operations["getItemBySku"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/upload-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start a photo upload session
         * @description Returns one pre-signed upload target per file. The client sends each file's bytes
         *     with the given method, URL, and headers (directly to object storage; background
         *     uploads are fine), then attaches each uploaded file to an item with `addItemPhoto`.
         *     Clients resize to at most 2048 px on the long edge, encode JPEG, and strip GPS before
         *     uploading. Upload targets expire after 15 minutes (`getUploadSession` returns fresh
         *     ones) and the session after 24 hours; files must be attached before it expires.
         */
        post: operations["createUploadSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/upload-sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        /**
         * Get an upload session
         * @description Used to resume after an app relaunch: shows which files the server already has, and
         *     returns fresh upload targets for files still `pending`.
         */
        get: operations["getUploadSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{itemId}/photos": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Attach an uploaded file to an item as a photo
         * @description The server checks that the file's bytes arrived and match the declared size and
         *     SHA-256 (`409 upload_incomplete` if not), then creates the photo in `processing`
         *     while it derives the thumbnail, AI, and listing images.
         */
        post: operations["addItemPhoto"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{itemId}/photo-order": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Reorder an item's photos
         * @description `photoIds` must list every photo of the item exactly once; the first is the cover.
         */
        put: operations["reorderItemPhotos"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{itemId}/photos/{photoId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
                photoId: components["parameters"]["PhotoId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a photo from an item */
        delete: operations["deleteItemPhoto"];
        options?: never;
        head?: never;
        /** Change a photo's role */
        patch: operations["updateItemPhoto"];
        trace?: never;
    };
    "/v1/items/{itemId}/analyses": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Analyze the item's current photos
         * @description Starts the default ("fast") analysis of the item's current photo set. Analysis runs
         *     once per item and photo set: when an analysis of the same photo-set hash exists, it is
         *     returned instead of running (and paying for) a new one; a `failed` one is queued again,
         *     since asking again is how a failure is retried. Poll `getAnalysis` until `status` is
         *     `completed` or `failed`. The photo set is every photo of the item, so all of them must
         *     be `ready`: `409 invalid_state_transition` when the item has no photos or one is still
         *     `processing` or `failed` (remove or replace it first). Refused before anything is
         *     queued: `402 quota_exceeded` when the plan's AI items for the month are used up,
         *     `429 ai_budget_exceeded` when the account's daily AI budget is used up, and
         *     `503 service_unavailable` while AI is switched off.
         */
        post: operations["startItemAnalysis"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/analyses/{analysisId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                analysisId: components["parameters"]["AnalysisId"];
            };
            cookie?: never;
        };
        /** Get an analysis */
        get: operations["getAnalysis"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/analyses/{analysisId}/escalate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                analysisId: components["parameters"]["AnalysisId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Identify harder (premium analysis)
         * @description Runs the premium identification on the same photos plus the first result. Counts
         *     against the plan's premium quota (`402 quota_exceeded` when used up). Repeating the
         *     request for the same analysis returns the existing premium analysis, or queues it
         *     again when it `failed`. The server also starts it on its own when a fast analysis
         *     needs it (`needsEscalation`) and the quota allows; the fast analysis then names it in
         *     `escalationAnalysisId`. `409 invalid_state_transition` until the analysis has
         *     `completed`, and for an analysis that is already `premium`. `429 ai_budget_exceeded`
         *     and `503 service_unavailable` as for `startItemAnalysis`.
         */
        post: operations["escalateAnalysis"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/analyses/{analysisId}/apply": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                analysisId: components["parameters"]["AnalysisId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fill the item's details from an analysis
         * @description Copies the completed analysis's proposed details into its item and records it as the
         *     item's `acceptedAnalysisId`. Each copied detail takes the analysis's provenance (`ai`,
         *     `ocr`, or `barcode`) in `fieldProvenance`. Details the user entered or edited
         *     (provenance `user`) are never overwritten, and a detail the analysis did not find is
         *     left as it is. `expectedVersion` must equal the item's current `version`
         *     (`409 version_conflict` otherwise); `409 invalid_state_transition` until the analysis
         *     has `completed`. Never calls AI.
         */
        post: operations["applyAnalysis"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/item-batches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start a batch
         * @description Starts an empty batch: the items of one haul, photographed in one session. Add one item
         *     per physical item with `addItemBatchItem`, attach its photos as for any item, then
         *     `submitItemBatchItem`: the server starts its analysis once the photos are processed.
         */
        post: operations["createItemBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/item-batches/{batchId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batchId: components["parameters"]["BatchId"];
            };
            cookie?: never;
        };
        /**
         * Get a batch
         * @description The batch's items in haul order, each with where it is (`state` and the server's
         *     `statusDisplay`), and how many are in each state. Poll it while items upload and
         *     analyze; every state comes from the items, photos, and analyses themselves.
         */
        get: operations["getItemBatch"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/item-batches/{batchId}/items": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batchId: components["parameters"]["BatchId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add an item to a batch
         * @description Creates a `draft` item (with its SKU) at `position` in the batch. A position the batch
         *     already has answers `200` with that item instead of creating another, so an app that
         *     submits its batch again, even after the Idempotency-Key has expired, never creates an
         *     item twice.
         */
        post: operations["addItemBatchItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/item-batches/{batchId}/items/{itemId}/submit": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batchId: components["parameters"]["BatchId"];
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Analyze a batch item once its photos are ready
         * @description Says the app has attached all `photoCount` photos of the item. The server starts the
         *     item's analysis as soon as they are processed, under the same rules as
         *     `startItemAnalysis`: an existing analysis of the photo set is kept, a failed one is
         *     queued again, and the AI guards are checked first. A refusal (the daily AI budget, the
         *     plan's quota, AI switched off) shows on the item as a `failed` state with its reason
         *     instead of an error here. Submitting again is the item's Retry. `409
         *     invalid_state_transition` when the item does not have `photoCount` photos yet.
         */
        post: operations["submitItemBatchItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/item-batches/{batchId}/interaction": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batchId: components["parameters"]["BatchId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Record the seller's interaction with a batch
         * @description Replaces the interaction the app measured for the batch (from its first photo to its
         *     last saved item) and each item's share of it. An item left out has none. `422` when an
         *     `itemId` is not an item of the batch.
         */
        put: operations["replaceItemBatchInteraction"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the plan's quota use
         * @description The account's use of each plan quota in the current period (the UTC calendar month
         *     until billing periods exist): AI items analyzed and premium identifications ("Identify
         *     harder"). A quota without `limit` is unlimited. Units are counted when a call succeeds,
         *     so a request that is still running is not counted yet.
         */
        get: operations["getUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{itemId}/voice-corrections": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Interpret a spoken correction the app could not parse
         * @description Maps the short text of a spoken correction on the review screen ("the pattern is
         *     houndstooth, it's from the nineties") to proposed detail changes, with the cheap text
         *     model. The app transcribes speech on the device and parses routine phrases itself, so
         *     it sends only the phrases its own parser could not map, and only their text, never
         *     audio. The answer is a proposal: nothing is changed on the item, and the app shows each
         *     change for the seller to accept or undo before it saves anything (`replaceItem`).
         *     Canonical details (category, department, size type, colors, pattern, materials,
         *     condition) hold canonical values only, and `cost` and `listPrice` carry an `amount`;
         *     every other change carries a `value`. A phrase the model could not map is left out, so
         *     `changes` may be empty. The call is metered and counted in the account's daily AI
         *     budget like every AI call, but uses no plan quota: `429 ai_budget_exceeded` when the
         *     budget is used up, `503 service_unavailable` while AI is switched off or the model
         *     could not answer (retryable), and `403 forbidden` when AI is turned off for the account.
         */
        post: operations["interpretVoiceCorrection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{itemId}/pricing": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        /**
         * Get price suggestions for an item
         * @description Every number carries its source. Without real sold data the response has no
         *     `soldComparables`, says so in `noSoldDataMessage`, and its tiers are based on the
         *     labeled AI estimate and the cost floor. Computing suggestions never calls AI; the
         *     estimate comes from the item's analysis. No eBay content is used to compute any price.
         */
        get: operations["getItemPricing"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{itemId}/listings": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        /**
         * List an item's marketplace listings
         * @description At most one listing per marketplace, so this list is not paginated.
         */
        get: operations["listItemListings"];
        put?: never;
        /**
         * Create a draft listing for a marketplace
         * @description Creates the marketplace-specific variant as a `draft`. Nothing is sent to the
         *     marketplace until `publishListing`. `409 already_exists` when the item already has a
         *     listing on that marketplace.
         */
        post: operations["createListing"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{itemId}/listing-links": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Link a listing the user already has on a marketplace
         * @description Records a listing the user created on a marketplace themselves, from the URL they
         *     shared from Safari or the marketplace app. The server reads the marketplace and the
         *     listing id from the URL (see `ListingLinkCreate`) and never fetches it. The listing is
         *     `assisted` and `active`, and its `verification` is `user_confirmation`: it is the
         *     user's word, never shown as confirmed by the marketplace. A `draft` or `ready` item
         *     becomes `listed`.
         *
         *     `409 already_exists` when this listing is already linked to an item (the message
         *     names that item's SKU) or the item already has a live listing on that marketplace.
         *     `409 invalid_state_transition` when the item is sold, shipped, archived, or being
         *     delisted after a sale. `422 validation_failed` (field `url`) when the URL is not a
         *     listing on a supported marketplace.
         */
        post: operations["linkItemListing"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listing-imports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an item for a shared listing and link the listing to it
         * @description For a listing the user shared that has no item in Listora yet. Creates an import
         *     placeholder item, with the account's next SKU and the given title as its only detail
         *     (the user adds the rest later), and links the listing to it exactly as
         *     `linkItemListing` does, in one transaction. The item is `listed`.
         *
         *     `409 already_exists` when this listing is already linked to an item (the message
         *     names that item's SKU). `422 validation_failed` (field `url`) when the URL is not a
         *     listing on a supported marketplace.
         */
        post: operations["importSharedListing"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List listings across items
         * @description For views such as "everything that failed" or "everything on Depop". Newest first.
         */
        get: operations["listListings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listings/{listingId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        /** Get a listing and its current status */
        get: operations["getListing"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listings/{listingId}/variant": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Replace a draft listing's variant
         * @description Only for `draft` listings; it changes nothing on the marketplace. A live listing is
         *     changed with `reviseListing` or `changeListingPrice` (`409 invalid_state_transition`
         *     otherwise).
         */
        put: operations["replaceListingDraft"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listings/{listingId}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Publish a draft listing to its marketplace
         * @description Queues a `create` operation. On an API marketplace the listing becomes `active` only
         *     after the marketplace confirms it on read-back. On an assisted marketplace it opens a
         *     `list_manually` task and the operation waits in `needs_user_action`.
         */
        post: operations["publishListing"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listings/{listingId}/revise": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Change a live listing's details
         * @description Queues a `revise` operation with the new variant (title, description, aspects, price).
         *     Assisted marketplaces get an `edit_manually` task.
         */
        post: operations["reviseListing"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listings/{listingId}/price": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Change a live listing's price
         * @description Queues a `price` operation. The listed price changes only once it is confirmed.
         *     Assisted marketplaces get an `edit_manually` task.
         */
        post: operations["changeListingPrice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listings/{listingId}/end": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * End (delist) a live listing
         * @description Queues an `end` operation. Assisted marketplaces get a `delist_manually` task.
         */
        post: operations["endListing"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listings/{listingId}/relist": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Relist an ended listing
         * @description Queues a `relist` operation. Some marketplaces relist as a new listing with new
         *     external ids (Depop gets a new external SKU); `externalListingId` changes when
         *     confirmed.
         */
        post: operations["relistListing"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/listings/{listingId}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Check the listing's real state on the marketplace again
         * @description Queues a `verify` operation (a read-back only; nothing is changed on the marketplace).
         *     Only for API listings; assisted listings answer `409 marketplace_action_unavailable`.
         */
        post: operations["verifyListing"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List marketplace operations
         * @description Newest first. Filters combine with AND.
         */
        get: operations["listOperations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/operations/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        /** Get an operation */
        get: operations["getOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/operations/{operationId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        /**
         * List an operation's history
         * @description Oldest first (by `sequence`). Events are append-only.
         */
        get: operations["listOperationEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/operations/{operationId}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Retry a failed operation
         * @description Only for `failed` operations. Queues the same operation again with a fresh set of
         *     attempts; its history keeps the failure. Its first step reads the listing back before
         *     sending anything, because an earlier attempt may have been applied.
         *     `409 invalid_state_transition` when the operation has not failed, or when a newer
         *     operation on the listing exists (retrying would undo it).
         */
        post: operations["retryOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/operations/{operationId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel an operation that has not been sent
         * @description Only while `queued` or `retrying`. Once a request may have reached the marketplace
         *     the operation cannot be canceled (`409 invalid_state_transition`), because its outcome
         *     must still be verified.
         */
        post: operations["cancelOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List marketplace connections
         * @description One entry per supported marketplace, including assisted ones, so not paginated.
         */
        get: operations["listConnections"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{marketplace}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        /** Get one marketplace connection */
        get: operations["getConnection"];
        put?: never;
        post?: never;
        /**
         * Disconnect a marketplace account
         * @description Unlinks the marketplace: deletes the stored tokens or session and the marketplace data
         *     that came through the connection (the marketplace's user id and name, listing read-backs,
         *     marketplace events, automation runs and their screenshots), and asks the marketplace to
         *     revoke Listora's access. Items, listings, and sales stay. Existing listings stay on the
         *     marketplace but Listora can no longer change or verify them until the account is
         *     connected again. `404` when no account of the marketplace is linked.
         */
        delete: operations["disconnectConnection"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{marketplace}/authorizations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start connecting a marketplace account (OAuth)
         * @description Returns the marketplace's official authorization URL. The app opens it in
         *     `ASWebAuthenticationSession` with `callbackUrlScheme`. The marketplace redirects the
         *     browser to `handleConnectionCallback`, which exchanges the code on the server and
         *     redirects to the app. The app then reads the result with
         *     `getConnectionAuthorization`; it never trusts the redirect alone. Listora never asks
         *     for marketplace passwords. `409 marketplace_action_unavailable` for marketplaces
         *     without an authorized API connection.
         */
        post: operations["startConnectionAuthorization"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{marketplace}/authorizations/{authorizationId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
                authorizationId: components["parameters"]["AuthorizationId"];
            };
            cookie?: never;
        };
        /** Get the result of a connection attempt */
        get: operations["getConnectionAuthorization"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{marketplace}/callback": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        /**
         * OAuth redirect target (called by the marketplace, not the app)
         * @description The marketplace redirects the user's browser here after consent. No bearer token: the
         *     single-use, short-lived `state` binds the request to the authorization attempt. The
         *     server exchanges the code and always answers with a redirect to the app
         *     (`listora://connections/{marketplace}?authorizationId=...`), also on failure; the
         *     app then calls `getConnectionAuthorization`. Query parameter names follow OAuth 2.0.
         *     A request whose `state` names no attempt (missing, unknown, or already used by another
         *     marketplace) changes nothing and redirects without `authorizationId`; the app then
         *     reads the attempt it started. A repeated callback with the same `state` only redirects
         *     again.
         */
        get: operations["handleConnectionCallback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{marketplace}/checks": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Check a marketplace connection now (Retry check)
         * @description Queues the same cheap read the daily health check makes, for this connection only. For
         *     an automation connection it asks for a check of the sign-in already linked again, where
         *     the connection runs (the browser runner or the seller's iPhone), as after linking (`getMarketplaceSession`), without the seller signing in again;
         *     a check still running is left to finish. The answer is the connection with a `Checking`
         *     status; read it again (or `getConnectionHealth`, or `getMarketplaceSession`) to see what
         *     the check found. Offered as the `check` action on a connection with a problem.
         *     `409 invalid_state_transition` for a connection a check cannot change (not connected,
         *     or waiting for the seller to reconnect or link again); `409
         *     marketplace_action_unavailable` when this server cannot check the marketplace.
         */
        post: operations["requestConnectionCheck"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connections/{marketplace}/execution": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Choose where a connection's automated steps run
         * @description Moves the connection's automated steps to Listora's cloud browser runner or to the
         *     iPhone that linked it (docs/features/phone-execution.md). Work waiting for the phone
         *     moves to the cloud with it; a run the phone is in the middle of finishes there.
         *     `409 invalid_state_transition` for a marketplace that is not linked by signing in.
         */
        put: operations["setConnectionExecution"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/connection-health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The account's connection health summary
         * @description Every marketplace's connection (as `listConnections`), what needs the seller's
         *     attention (broken or failing connections and grants that end within 30 days), the
         *     banner the app shows while anything does, and sale email forwarding.
         */
        get: operations["getConnectionHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/marketplace-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the marketplaces linked by signing in
         * @description One entry per marketplace whose connection can be a browser session (`connect:
         *     session`): Poshmark, Mercari, Depop, and eBay (Depop and eBay until their APIs are
         *     connected; an API connection is `api_connected`). Each says whether it is linked, where
         *     the app opens the marketplace's sign-in page, and which cookies to hand over. Not
         *     paginated.
         */
        get: operations["listMarketplaceSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/marketplace-sessions/{marketplace}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        /**
         * Get one marketplace's sign-in link
         * @description The app polls this after `linkMarketplaceSession` until `status` is no longer
         *     `checking`. `404` for a marketplace that is not linked by signing in.
         */
        get: operations["getMarketplaceSession"];
        put?: never;
        /**
         * Link a marketplace with the session the user signed into in the app
         * @description The user signed into the marketplace's own sign-in page (`login.url`) inside the app,
         *     in a web view with its own data store, including any two-step check. The app sends
         *     that site's cookies (only those on `login.cookieDomains`), never the password, which
         *     Listora never sees. The server stores them encrypted with the token key (KMS envelope
         *     encryption) on the account's automation connection for the marketplace, and asks for one
         *     read-only check that the marketplace accepts them, where the connection runs: the
         *     browser runner, or the iPhone that linked it (`installationId`). The reply is
         *     `checking`; poll `getMarketplaceSession` for `linked` or `check_failed`. Relinking
         *     takes the same way and replaces the earlier session. Cookie values are never logged
         *     or returned.
         *
         *     `404` for a marketplace that is not linked by signing in. `409
         *     marketplace_action_unavailable` when the marketplace is connected through its API.
         *     `422 validation_failed` (field `cookies`) when a cookie is on another site's domain,
         *     every cookie has expired, or there are none.
         */
        post: operations["linkMarketplaceSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sales": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List sales
         * @description The sales feed, newest first (by when Listora recorded them), each with its delist runs.
         */
        get: operations["listSales"];
        put?: never;
        /**
         * Record a sale manually ("Mark sold")
         * @description For sales Listora did not detect itself. One sale is one order; a bundle lists several
         *     items. Starts the same automatic delist run as a detected sale: every other listing
         *     of every item in the order gets a delist operation or an urgent assisted task. A
         *     sale that contains an already-sold item is recorded with `isDoubleSale: true` and a
         *     double-sale incident for that item instead of a second delist run.
         *     `422 validation_failed` when an item appears twice or a `listingId` does not belong
         *     to its item on `marketplace`.
         */
        post: operations["createSale"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sales/{saleId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        /** Get a sale and its delist run */
        get: operations["getSale"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sales/{saleId}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm a sale
         * @description The seller confirms a `detected` sale. `409 invalid_state_transition` for any other
         *     status; `availableActions` lists what a sale allows.
         */
        post: operations["confirmSale"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sales/{saleId}/ship": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark a sale shipped
         * @description A `detected` or `confirmed` sale is `shipped`, and its items too. `shippingCost`
         *     records what the label cost outside the payout, for the profit; send `{}` without one.
         */
        post: operations["markSaleShipped"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sales/{saleId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record that a sale was canceled
         * @description For a `detected` or `confirmed` sale whose order was canceled. Delists of the sale that
         *     reached no marketplace yet are stopped; the rest finish and show what is true. Each
         *     item with no other sale that stands goes back to inventory, and Listora asks whether
         *     to relist it (`items[].relist`, decided with `decideSaleRelist`). Nothing is relisted
         *     until the seller chooses.
         */
        post: operations["cancelSale"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sales/{saleId}/return": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record that a sale was returned
         * @description For a `confirmed` or `shipped` sale the buyer returned. As with `cancelSale`, the
         *     items go back to inventory and Listora asks whether to relist them.
         */
        post: operations["recordSaleReturn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sales/{saleId}/relist": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Answer "Relist it?" after a cancel or return
         * @description For each item whose `relist.decision` is `pending`: relist it on the chosen listings
         *     (each one a `relist` operation on the engine, shown on the item's listings until the
         *     marketplace confirms it or the user does an assisted step), or, with no listings, don't
         *     relist it. `409 invalid_state_transition` when an item's decision is not pending;
         *     `422 validation_failed` when a listing is not one of the item's options that can be
         *     relisted now.
         */
        post: operations["decideSaleRelist"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/profit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the profit dashboard for a period
         * @description The seller's results for the days `from` to `to` (inclusive) in `timeZone`: revenue,
         *     fees, shipping, cost of goods, net profit, ROI, the averages, sell-through, a series by
         *     day, week, or month, the seller's own totals per marketplace (in a fixed order, never
         *     ranked), the best and worst brands and categories, and dead stock today. Every amount is
         *     computed from the sales' fee lines and the items' costs exactly as each sale's own money
         *     is (`Sale`), so the dashboard and the sale screens agree to the cent. No AI is involved.
         *     `422 validation_failed` when `to` is before `from`, the period is longer than 3660 days,
         *     or `timeZone` is not an IANA time zone.
         */
        get: operations["getProfit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List assisted-mode tasks
         * @description Urgent first, then oldest first.
         */
        get: operations["listTasks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tasks/{taskId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                taskId: components["parameters"]["TaskId"];
            };
            cookie?: never;
        };
        /** Get a task */
        get: operations["getTask"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tasks/{taskId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                taskId: components["parameters"]["TaskId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm that the user did the task
         * @description The explicit user confirmation that finishes an assisted operation. The linked
         *     listing then shows "Done (you confirmed)", never "confirmed by <marketplace>".
         *     `409 invalid_state_transition` when the task is not `open`.
         */
        post: operations["completeTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tasks/{taskId}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                taskId: components["parameters"]["TaskId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Dismiss a task without doing it
         * @description Dismissing never counts as doing the work: a linked operation becomes `failed` (with
         *     a Retry action), not `succeeded`.
         */
        post: operations["dismissTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sale-emails": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the sale email forwarding address and its status
         * @description The account's forwarding address (created on first use), the setup steps, the provider's
         *     forwarding confirmation while it waits, and the "ask before auto-delist" setting.
         */
        get: operations["getSaleEmails"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sale-emails/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Replace the sale email setting
         * @description Turns "ask before auto-delist" on or off for sales found by email.
         */
        put: operations["replaceSaleEmailSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/today": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get what needs the seller today
         * @description The Today screen: one card per thing that needs the seller (items to ship, delists that
         *     are not done, connections to reconnect, drafts to review, and old listings that could use
         *     a price drop or a relist), most urgent first, and the money summary. Computed from the
         *     account's own data on every request, with no AI and no marketplace call, so the app asks
         *     for it each time it opens. A card is gone once its work is done.
         */
        get: operations["getToday"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/today/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the morning summary setting
         * @description The account's morning summary notification setting (defaults until saved).
         */
        get: operations["getTodaySettings"];
        /**
         * Replace the morning summary setting
         * @description Turns the morning summary on or off and sets its time, in the device's time zone. A time
         *     zone the server does not know is `422 validation_failed`.
         */
        put: operations["replaceTodaySettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/devices/{installationId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The app installation's id, which it keeps in its Keychain. */
                installationId: components["parameters"]["InstallationId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Register this device
         * @description The app registers its installation (an id it keeps in its Keychain) on every launch and
         *     whenever its APNs token changes: its name, the phone runtime version it speaks, and
         *     where push notifications reach it. The device that links a marketplace runs that
         *     marketplace's automated steps when they run on the phone.
         */
        put: operations["registerDevice"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/phone-runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Claim the next work waiting for this phone
         * @description Claims the next due work waiting for the device (delists after a sale first) and
         *     returns its first script call; no `run` when nothing waits. The claim holds for a few
         *     minutes from each call and answer; a phone that stops answering lets it lapse, and the
         *     work is recovered on the server. `409 app_update_required` when the app's runtime
         *     speaks another version of calls than the server's.
         */
        post: operations["claimPhoneRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/phone-runs/{runId}/calls/{index}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
                /** @description The call's place in its run, from 0 (path parameters are text). */
                index: components["parameters"]["CallIndex"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Answer a phone call of a run
         * @description The phone's answer for the run's call `index`, as its runtime returned it. The server
         *     records it, runs the work on with it, and returns the next call; no `run` once the work
         *     is done (its result recorded). Sending the same answer again changes nothing. `404`
         *     when the run is over or lapsed; `409 invalid_state_transition` for an answer to a call
         *     the run is not waiting for.
         */
        put: operations["answerPhoneCall"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * Format: uuid
         * @description Server-generated UUID.
         */
        Id: string;
        /**
         * Format: date-time
         * @description RFC 3339 timestamp in UTC.
         */
        Timestamp: string;
        /** @description Account prefix, a dash, and a zero-padded gapless number, for example `AJ-000184`. */
        Sku: string;
        /**
         * @description ISO 4217 code. Listora launches US-only, so USD is the only currency for now.
         * @enum {string}
         */
        CurrencyCode: "USD";
        /** @description An amount in integer minor units (cents) plus a currency. Never a floating-point amount. */
        Money: {
            /**
             * Format: int64
             * @description Integer minor units, for example 3400 for $34.00.
             */
            amountCents: number;
            currency: components["schemas"]["CurrencyCode"];
        };
        /**
         * @description A `KnownMarketplace`, or a marketplace added after this client was built. Clients show
         *     an unknown marketplace generically (its raw id and the server's `statusDisplay`).
         */
        Marketplace: components["schemas"]["KnownMarketplace"];
        /** @enum {string} */
        KnownMarketplace: "ebay" | "depop" | "poshmark" | "mercari";
        /**
         * @description A `KnownIntegrationMode`, or a mode added after this client was built. Clients offer
         *     nothing that depends on an unknown mode.
         */
        IntegrationMode: components["schemas"]["KnownIntegrationMode"];
        /**
         * @description `api`: Listora acts through the marketplace's official API and verifies by read-back.
         *     `automation`: Listora's browser runner, or the iPhone app (`execution`), acts in the
         *     seller's own marketplace session (where the marketplace permits it and has no API) and
         *     verifies by read-back through that session. `assisted`: Listora prepares the work and the user does the final step in the
         *     marketplace app, then confirms.
         * @enum {string}
         */
        KnownIntegrationMode: "api" | "automation" | "assisted";
        /**
         * @description A `KnownStatusTone`, or a tone added after this client was built. Clients style an
         *     unknown tone like `neutral` and still show the `label`.
         */
        StatusTone: components["schemas"]["KnownStatusTone"];
        /**
         * @description How to style a status. `success` is used only for states verified by an API read-back
         *     or confirmed by the user.
         * @enum {string}
         */
        KnownStatusTone: "success" | "in_progress" | "checking" | "failed" | "action_needed" | "neutral";
        /**
         * @description Server-rendered honest status, for example `Active (confirmed by eBay)`,
         *     `Delisting... retry 2 of 6`, `Delist failed - Retry`, `Checking...`,
         *     `Action needed - delist on Poshmark`, or `Done (you confirmed)`. Clients show
         *     `label` as given and never compute success themselves.
         */
        StatusDisplay: {
            tone: components["schemas"]["StatusTone"];
            label: string;
            /** @description Extra context, for example the marketplace's error text. */
            detail?: string;
        };
        /**
         * @description `marketplace_api`: confirmed by a read-back from the marketplace (its API, or the automated browser session). `user_confirmation`: the user confirmed an assisted task.
         * @enum {string}
         */
        VerificationMethod: "marketplace_api" | "user_confirmation";
        /** @description How and when the current state was established. Absent when it is not verified. */
        Verification: {
            method: components["schemas"]["VerificationMethod"];
            verifiedAt: components["schemas"]["Timestamp"];
        };
        /**
         * @description A `KnownProvenance`, or a source added after this client was built. Clients treat an
         *     unknown source as not entered by the user (highlight it for review).
         */
        Provenance: components["schemas"]["KnownProvenance"];
        /**
         * @description Where a field value came from.
         * @enum {string}
         */
        KnownProvenance: "ai" | "ocr" | "barcode" | "user";
        /** @description The body of every error response. */
        ErrorResponse: {
            error: components["schemas"]["ApiError"];
        };
        ApiError: {
            code: components["schemas"]["ErrorCode"];
            /** @description User-readable explanation, safe to show as is. Never contains secrets. */
            message: string;
            /**
             * @description True when the same request may succeed later without changes. Retry it with the
             *     same `Idempotency-Key`, after `retryAfterSeconds` when present.
             */
            retryable: boolean;
            /** Format: int32 */
            retryAfterSeconds?: number;
            /** @description Correlates with server logs; show it in support views. */
            requestId: string;
            /** @description Per-field problems for `validation_failed`. */
            fieldErrors?: components["schemas"]["FieldError"][];
        };
        FieldError: {
            /** @description Dotted path into the request body, for example `details.title` or `variant.price`. */
            field: string;
            message: string;
        };
        /**
         * @description A `KnownErrorCode`, or a code added after this client was built. Clients must handle
         *     unknown codes by using `message` and `retryable`, so new codes never break decoding.
         */
        ErrorCode: components["schemas"]["KnownErrorCode"];
        /**
         * @description HTTP status per code: `invalid_request` 400; `unauthenticated` 401; `quota_exceeded`
         *     402; `forbidden` 403; `not_found` 404; `version_conflict`, `invalid_state_transition`,
         *     `already_exists`, `idempotency_key_in_progress`, `upload_incomplete`,
         *     `upload_expired`, `marketplace_not_connected`, `marketplace_reauth_required`,
         *     `marketplace_action_unavailable`, `app_update_required` 409; `payload_too_large` 413; `validation_failed`,
         *     `idempotency_key_reused` 422; `rate_limited`, `ai_budget_exceeded` 429;
         *     `internal_error` 500; `service_unavailable` 503. `marketplace_authorization_denied`
         *     and `marketplace_authorization_failed` appear only inside a failed
         *     `ConnectionAuthorization`.
         * @enum {string}
         */
        KnownErrorCode: "invalid_request" | "unauthenticated" | "quota_exceeded" | "forbidden" | "not_found" | "version_conflict" | "invalid_state_transition" | "already_exists" | "idempotency_key_in_progress" | "upload_incomplete" | "upload_expired" | "marketplace_not_connected" | "marketplace_reauth_required" | "marketplace_action_unavailable" | "app_update_required" | "payload_too_large" | "validation_failed" | "idempotency_key_reused" | "rate_limited" | "ai_budget_exceeded" | "internal_error" | "service_unavailable" | "marketplace_authorization_denied" | "marketplace_authorization_failed";
        AccountDeletion: {
            deletedAt: components["schemas"]["Timestamp"];
            /** @description One entry per API marketplace connection the account had; assisted connections hold no access. */
            marketplaceAccess: components["schemas"]["MarketplaceAccessRevocation"][];
        };
        MarketplaceAccessRevocation: {
            marketplace: components["schemas"]["Marketplace"];
            /** @description The seller's name on the marketplace. */
            displayName?: string;
            /**
             * @description True only when the marketplace had confirmed, before the deletion, that Listora's
             *     access is revoked. False means it is not confirmed, so the user must revoke it
             *     manually in the marketplace's settings (Listora also keeps asking the marketplace
             *     for up to 7 days when it still holds the connection's tokens).
             */
            revoked: boolean;
        };
        /** @enum {string} */
        HealthCheckStatus: "ok" | "unavailable";
        HealthLive: {
            status: components["schemas"]["HealthCheckStatus"];
        };
        HealthReady: {
            status: components["schemas"]["HealthCheckStatus"];
            checks: {
                database: components["schemas"]["HealthCheckStatus"];
            };
        };
        /**
         * @description A `KnownItemStatus`, or a status added after this client was built. Clients show an
         *     unknown status generically and offer no status-specific action for it.
         */
        ItemStatus: components["schemas"]["KnownItemStatus"];
        /**
         * @description `draft` and `ready` are set by the user; `archived` by the user for an item with no
         *     live listing. `listed`, `sold_pending_delist`, `sold`, and `shipped` are set by the
         *     server from listings and sales. An archived item can be set back to either `draft` or
         *     `ready` only if it was `draft` or `ready` when it was archived and has never been sold;
         *     otherwise the server answers `409 invalid_state_transition` and the item stays
         *     archived.
         * @enum {string}
         */
        KnownItemStatus: "draft" | "ready" | "listed" | "sold_pending_delist" | "sold" | "shipped" | "archived";
        /**
         * @description The item statuses a client may set directly.
         * @enum {string}
         */
        UserSettableItemStatus: "draft" | "ready" | "archived";
        /**
         * @description Canonical condition; each marketplace adapter maps it to that marketplace's values.
         * @enum {string}
         */
        ItemCondition: "new_with_tags" | "new_without_tags" | "new_with_defects" | "pre_owned_excellent" | "pre_owned_good" | "pre_owned_fair";
        /** @enum {string} */
        MeasurementUnit: "in" | "cm";
        Measurement: {
            /** @description Canonical name, for example `pit_to_pit`, `length`, `inseam`. */
            name: string;
            value: number;
            unit: components["schemas"]["MeasurementUnit"];
        };
        /**
         * @description Every user-editable property of an item. All are optional: a property that is absent
         *     has no value. `replaceItem` replaces this object as a whole.
         */
        ItemDetails: {
            title?: string;
            description?: string;
            brand?: string;
            productName?: string;
            styleNumber?: string;
            /** @description Registered identification number from the care tag. */
            rnNumber?: string;
            /** @description UPC or EAN digits, checksum-validated by the server. */
            upc?: string;
            /** @description Canonical department, for example `women`, `men`, `kids`, `unisex`. */
            department?: string;
            /**
             * @description Canonical taxonomy path `<category>/<subcategory>`, for example
             *     `clothing/tops/t_shirts` (`CATEGORY_TREE` in @listora/analysis).
             */
            category?: string;
            /** @description The size as printed, for example `M` or `32x30`. */
            sizeLabel?: string;
            /**
             * @description How to read `sizeLabel`: `letter` (XS to XXXL), `numeric`, `waist_inseam`
             *     (`32x30`), `us`, `uk`, or `eu` (labeled on the tag), or `one_size`.
             */
            sizeSystem?: string;
            colors?: string[];
            pattern?: string;
            materials?: string[];
            condition?: components["schemas"]["ItemCondition"];
            conditionNotes?: string;
            flaws?: string[];
            keywords?: string[];
            measurements?: components["schemas"]["Measurement"][];
            listPrice?: components["schemas"]["Money"];
            floorPrice?: components["schemas"]["Money"];
            cost?: components["schemas"]["Money"];
            /** Format: date */
            purchaseDate?: string;
            purchaseSource?: string;
            /**
             * Format: int32
             * @default 1
             */
            quantity: number;
            /** @description The storage location where the item is kept (for example a bin or shelf). */
            storageLocationId?: components["schemas"]["Id"];
            /** @description The analysis whose proposals the user accepted; see `Item.fieldProvenance`. */
            acceptedAnalysisId?: components["schemas"]["Id"];
        };
        ItemCreate: {
            details?: components["schemas"]["ItemDetails"];
        };
        ItemReplace: {
            /**
             * Format: int64
             * @description The `version` the client last read (optimistic lock).
             */
            expectedVersion: number;
            status?: components["schemas"]["UserSettableItemStatus"];
            details: components["schemas"]["ItemDetails"];
        };
        Item: {
            id: components["schemas"]["Id"];
            sku: components["schemas"]["Sku"];
            status: components["schemas"]["ItemStatus"];
            /**
             * Format: int64
             * @description Increases on every change; send it back as `expectedVersion`.
             */
            version: number;
            details: components["schemas"]["ItemDetails"];
            /**
             * @description Read-only: where each detail came from, keyed by property name, for example
             *     `{"brand": "ocr"}`. The server owns it and clients never send it. A detail whose
             *     value equals the accepted analysis's value keeps that analysis's source; any other
             *     detail written through the API is `user`.
             */
            fieldProvenance?: {
                [key: string]: components["schemas"]["Provenance"];
            };
            /** @description Read-only; the location `details.storageLocationId` refers to. */
            storageLocation?: components["schemas"]["StorageLocationSummary"];
            /** @description In display order; the first is the cover. */
            photos: components["schemas"]["Photo"][];
            listings: components["schemas"]["Listing"][];
            saleSummary?: components["schemas"]["ItemSaleSummary"];
            /**
             * @description The delist run of the item's latest sale (the "Sold" banner and the delist results),
             *     once the item has sold. Absent for an item that never sold.
             */
            delistRun?: components["schemas"]["DelistRun"];
            /** @description The item's newest double sale that is still open; absent when there is none. */
            doubleSale?: components["schemas"]["DoubleSale"];
            relistPrompt?: components["schemas"]["ItemRelistPrompt"];
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
        };
        /** @description Where an item is kept. */
        StorageLocationSummary: {
            id: components["schemas"]["Id"];
            /** @description The short code printed on the bin or shelf, for example `B-12`. */
            code: string;
            /** @description For example "Garage shelf 3, bin 12". */
            label: string;
        };
        /**
         * @description The item's sale was canceled or returned and the seller has not decided whether to
         *     relist it. The app asks, with the options in the sale's `items[].relist`.
         */
        ItemRelistPrompt: {
            saleId: components["schemas"]["Id"];
            /** @description `canceled` or `returned`. */
            saleStatus: components["schemas"]["SaleStatus"];
            soldOn: components["schemas"]["Marketplace"];
        };
        /**
         * @description Read-only result of the item's sale. Present only when the item has sold (status
         *     `sold_pending_delist`, `sold`, or `shipped`). For an item sold in a bundle, the
         *     order's fees and shipping cost are split across its items in proportion to each
         *     item's `salePrice`. A value is absent until it is known.
         */
        ItemSaleSummary: {
            saleId: components["schemas"]["Id"];
            soldOn?: components["schemas"]["Marketplace"];
            saleStatus?: components["schemas"]["SaleStatus"];
            /** @description True while any of the sale's fees is an estimate; `netProceeds` and `profit` are estimates then. */
            feesEstimated?: boolean;
            soldAt: components["schemas"]["Timestamp"];
            salePrice: components["schemas"]["Money"];
            /** @description This item's share of the sale's `netProceeds`. */
            netProceeds?: components["schemas"]["Money"];
            /** @description This item's share of `netProceeds`, minus its share of `shippingCost`, minus its `cost`. */
            profit?: components["schemas"]["Money"];
            /**
             * Format: int64
             * @description Return on investment, `profit` divided by the item's `cost`, in basis points
             *     (12550 is 125.5%). Absent when `profit` is absent or the cost is zero.
             */
            roiBasisPoints?: number;
        };
        /** @description The item as shown in inventory lists. */
        ItemSummary: {
            id: components["schemas"]["Id"];
            sku: components["schemas"]["Sku"];
            status: components["schemas"]["ItemStatus"];
            title?: string;
            brand?: string;
            sizeLabel?: string;
            listPrice?: components["schemas"]["Money"];
            coverPhoto?: components["schemas"]["Photo"];
            listings: components["schemas"]["ListingStatusSummary"][];
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
        };
        ItemPage: {
            data: components["schemas"]["ItemSummary"][];
            /** @description Present when there are more results. */
            nextCursor?: string;
        };
        /** @enum {string} */
        PhotoRole: "front" | "back" | "tag" | "flaw" | "detail";
        /**
         * @description `processing` until the derived images exist; `failed` when the file is not a usable image.
         * @enum {string}
         */
        PhotoStatus: "processing" | "ready" | "failed";
        /**
         * @description JPEG only: the server's image pipeline cannot decode HEIC, so clients convert photos to
         *     JPEG when they resize them.
         * @enum {string}
         */
        ImageContentType: "image/jpeg";
        /** @description A text line recognized on the device (Vision). */
        OcrLine: {
            text: string;
            confidence: number;
        };
        /** @description A barcode detected on the device. */
        Barcode: {
            /** @description For example `ean13`, `upce`, `qr`. */
            symbology: string;
            payload: string;
        };
        /** @description Unguessable URLs of the derived images; present only when the photo is `ready`. */
        PhotoUrls: {
            /**
             * Format: uri
             * @description 400 px long edge.
             */
            thumbnail: string;
            /**
             * Format: uri
             * @description 1600 px long edge; what marketplaces fetch.
             */
            listing: string;
        };
        Photo: {
            id: components["schemas"]["Id"];
            itemId: components["schemas"]["Id"];
            /** Format: int32 */
            position: number;
            role: components["schemas"]["PhotoRole"];
            status: components["schemas"]["PhotoStatus"];
            /** Format: int32 */
            width: number;
            /** Format: int32 */
            height: number;
            sha256: components["schemas"]["Sha256"];
            urls?: components["schemas"]["PhotoUrls"];
            /** @description Why the file is not a usable image, for the user; present only when `status` is `failed`. */
            failureReason?: string;
            ocrLines: components["schemas"]["OcrLine"][];
            barcodes: components["schemas"]["Barcode"][];
            createdAt: components["schemas"]["Timestamp"];
        };
        PhotoList: {
            data: components["schemas"]["Photo"][];
        };
        PhotoCreate: {
            uploadFileId: components["schemas"]["Id"];
            role: components["schemas"]["PhotoRole"];
            /**
             * Format: int32
             * @description Insert position; appended when absent.
             */
            position?: number;
            /** Format: int32 */
            width?: number;
            /** Format: int32 */
            height?: number;
            ocrLines?: components["schemas"]["OcrLine"][];
            barcodes?: components["schemas"]["Barcode"][];
        };
        PhotoUpdate: {
            role: components["schemas"]["PhotoRole"];
        };
        PhotoOrder: {
            photoIds: components["schemas"]["Id"][];
        };
        /** @description Lowercase hex SHA-256 of the file bytes. */
        Sha256: string;
        UploadFileCreate: {
            contentType: components["schemas"]["ImageContentType"];
            /**
             * Format: int64
             * @description At most 20 MiB.
             */
            byteSize: number;
            sha256: components["schemas"]["Sha256"];
        };
        UploadSessionCreate: {
            files: components["schemas"]["UploadFileCreate"][];
        };
        /**
         * @description `pending`: bytes not received yet. `uploaded`: bytes received and verified. `attached`: used by a photo.
         * @enum {string}
         */
        UploadFileStatus: "pending" | "uploaded" | "attached";
        HttpHeader: {
            name: string;
            value: string;
        };
        /** @description Where and how to send one file's bytes. Send exactly these headers. */
        UploadTarget: {
            /** @enum {string} */
            method: "PUT";
            /** Format: uri */
            url: string;
            headers: components["schemas"]["HttpHeader"][];
            expiresAt: components["schemas"]["Timestamp"];
        };
        UploadFile: {
            id: components["schemas"]["Id"];
            status: components["schemas"]["UploadFileStatus"];
            contentType: components["schemas"]["ImageContentType"];
            /** Format: int64 */
            byteSize: number;
            sha256: components["schemas"]["Sha256"];
            upload?: components["schemas"]["UploadTarget"];
        };
        UploadSession: {
            id: components["schemas"]["Id"];
            expiresAt: components["schemas"]["Timestamp"];
            /** @description In the order of the request's `files`. `upload` is present only for `pending` files. */
            files: components["schemas"]["UploadFile"][];
            createdAt: components["schemas"]["Timestamp"];
        };
        /**
         * @description `fast`: the default low-cost model. `premium`: "Identify harder", counted against the plan quota.
         * @enum {string}
         */
        AnalysisTier: "fast" | "premium";
        /** @enum {string} */
        AnalysisStatus: "queued" | "running" | "completed" | "failed";
        /**
         * @description A `KnownAnalysisProvenance`, or a source added after this client was built. Clients
         *     treat an unknown source like `ai`.
         */
        AnalysisProvenance: components["schemas"]["KnownAnalysisProvenance"];
        /**
         * @description Where an analyzed value came from (users are not a source inside an analysis).
         * @enum {string}
         */
        KnownAnalysisProvenance: "ai" | "ocr" | "barcode";
        /** @description 0 to 1. Clients highlight low-confidence fields for review. */
        Confidence: number;
        AnalyzedText: {
            value: string;
            confidence: components["schemas"]["Confidence"];
            provenance: components["schemas"]["AnalysisProvenance"];
        };
        AnalyzedTextList: {
            values: string[];
            confidence: components["schemas"]["Confidence"];
            provenance: components["schemas"]["AnalysisProvenance"];
        };
        AnalyzedCondition: {
            value: components["schemas"]["ItemCondition"];
            confidence: components["schemas"]["Confidence"];
            provenance: components["schemas"]["AnalysisProvenance"];
        };
        /** @description Proposed item details; a property is absent when the analysis found nothing. */
        AnalyzedDetails: {
            title?: components["schemas"]["AnalyzedText"];
            description?: components["schemas"]["AnalyzedText"];
            brand?: components["schemas"]["AnalyzedText"];
            productName?: components["schemas"]["AnalyzedText"];
            styleNumber?: components["schemas"]["AnalyzedText"];
            rnNumber?: components["schemas"]["AnalyzedText"];
            upc?: components["schemas"]["AnalyzedText"];
            department?: components["schemas"]["AnalyzedText"];
            category?: components["schemas"]["AnalyzedText"];
            sizeLabel?: components["schemas"]["AnalyzedText"];
            sizeSystem?: components["schemas"]["AnalyzedText"];
            colors?: components["schemas"]["AnalyzedTextList"];
            pattern?: components["schemas"]["AnalyzedText"];
            materials?: components["schemas"]["AnalyzedTextList"];
            condition?: components["schemas"]["AnalyzedCondition"];
            conditionNotes?: components["schemas"]["AnalyzedText"];
            flaws?: components["schemas"]["AnalyzedTextList"];
            keywords?: components["schemas"]["AnalyzedTextList"];
        };
        /**
         * @description Marketplace-specific copy written by the analysis, within that marketplace's limits:
         *     eBay and Poshmark titles up to 80 characters, a Poshmark description up to 1,500, and
         *     a Mercari title and description up to 80 and 1,000. Depop has no title (this one is a
         *     short headline); its `description` and `hashtags` (up to 5, without the `#`) together
         *     fit Depop's 1,000 characters once the hashtags are appended on their own line.
         */
        VariantSuggestion: {
            marketplace: components["schemas"]["Marketplace"];
            title: string;
            description: string;
            hashtags?: string[];
        };
        AnalysisResult: {
            details: components["schemas"]["AnalyzedDetails"];
            variants: components["schemas"]["VariantSuggestion"][];
            priceEstimate?: components["schemas"]["AiPriceEstimate"];
            /**
             * @description True when a fast analysis suggests "Identify harder": its brand or product is
             *     uncertain, the item looks designer or vintage, or the model asked for it. Always
             *     false for a premium analysis.
             */
            needsEscalation: boolean;
            escalationReason?: string;
        };
        /**
         * @description Why the analysis failed. Starting or escalating it again queues it again; `retryable`
         *     says whether that may succeed without changing anything (for example after a
         *     provider outage), as opposed to needing other photos or a plan change.
         */
        AnalysisFailure: {
            /**
             * @description Stable snake_case, for example `invalid_output` (the AI's answer broke the schema
             *     twice), `rate_limited`, `ai_budget_exceeded`, `quota_exceeded`, `photo_set_changed`.
             */
            code: string;
            /** @description Safe to show to the user. */
            message: string;
            retryable: boolean;
        };
        Analysis: {
            id: components["schemas"]["Id"];
            itemId: components["schemas"]["Id"];
            photoSetHash: components["schemas"]["Sha256"];
            tier: components["schemas"]["AnalysisTier"];
            status: components["schemas"]["AnalysisStatus"];
            result?: components["schemas"]["AnalysisResult"];
            failure?: components["schemas"]["AnalysisFailure"];
            /** @description For a `premium` analysis, the fast analysis it escalates. */
            escalatedFromAnalysisId?: components["schemas"]["Id"];
            /** @description For a fast analysis, the premium analysis that escalates it, once started. */
            escalationAnalysisId?: components["schemas"]["Id"];
            createdAt: components["schemas"]["Timestamp"];
            /** @description When the analysis completed or failed. */
            completedAt?: components["schemas"]["Timestamp"];
        };
        AnalysisApply: {
            /**
             * Format: int64
             * @description The item `version` the client last read (optimistic lock).
             */
            expectedVersion: number;
        };
        /**
         * @description A `KnownItemBatchItemState`, or a state added after this client was built. Clients show
         *     an unknown state's `statusDisplay` as given and never treat it as saved.
         */
        ItemBatchItemState: components["schemas"]["KnownItemBatchItemState"];
        /**
         * @description Where a batch item is: `uploading` (the app has not submitted it yet), `preparing_photos`
         *     (the server is processing its photos), `analyzing`, `ready_for_review` (analyzed, waiting
         *     for the seller), `saved` (the seller saved it; its status is no longer `draft`), or
         *     `failed` (see `problem`).
         * @enum {string}
         */
        KnownItemBatchItemState: "uploading" | "preparing_photos" | "analyzing" | "ready_for_review" | "saved" | "failed";
        /** @description Why a batch item stopped. `retryable` says whether submitting it again may help as it is. */
        ItemBatchItemProblem: {
            /**
             * @description Stable snake_case, for example `photo_failed`, `photos_not_ready`, `no_photos`,
             *     `ai_budget_exceeded`, `quota_exceeded`, or an analysis failure's code.
             */
            code: string;
            /** @description Safe to show to the user. */
            message: string;
            retryable: boolean;
        };
        /**
         * @description The seller's interaction as the app measured it: time a screen of the flow was in front of
         *     them with nothing to wait for (`activeMs`), the time spent waiting on Listora meanwhile
         *     (`waitingMs`), and taps.
         */
        InteractionTotals: {
            /** Format: int64 */
            activeMs: number;
            /** Format: int64 */
            waitingMs: number;
            /** Format: int32 */
            taps: number;
        };
        /** @description How many of the item's photos the server has, and how many are processed. */
        ItemBatchPhotoProgress: {
            /** Format: int32 */
            total: number;
            /** Format: int32 */
            ready: number;
        };
        ItemBatchItem: {
            /**
             * Format: int32
             * @description The item's place in the haul, 0 first.
             */
            position: number;
            item: components["schemas"]["ItemSummary"];
            state: components["schemas"]["ItemBatchItemState"];
            statusDisplay: components["schemas"]["StatusDisplay"];
            photos: components["schemas"]["ItemBatchPhotoProgress"];
            /** @description Present exactly when `state` is `failed`. */
            problem?: components["schemas"]["ItemBatchItemProblem"];
            /** @description This item's share of the batch's interaction, once the app reported it. */
            interaction?: components["schemas"]["InteractionTotals"];
        };
        /** @description How many of the batch's items are in each state. */
        ItemBatchProgress: {
            /** Format: int32 */
            total: number;
            /** Format: int32 */
            uploading: number;
            /** Format: int32 */
            preparingPhotos: number;
            /** Format: int32 */
            analyzing: number;
            /** Format: int32 */
            readyForReview: number;
            /** Format: int32 */
            saved: number;
            /** Format: int32 */
            failed: number;
        };
        /** @description The items of one haul, photographed in one session, in haul order. */
        ItemBatch: {
            id: components["schemas"]["Id"];
            items: components["schemas"]["ItemBatchItem"][];
            progress: components["schemas"]["ItemBatchProgress"];
            /** @description The batch's interaction from its first photo, once the app reported it. */
            interaction?: components["schemas"]["InteractionTotals"];
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
        };
        ItemBatchItemCreate: {
            /**
             * Format: int32
             * @description The item's place in the haul, 0 first.
             */
            position: number;
        };
        ItemBatchItemSubmit: {
            /**
             * Format: int32
             * @description How many photos the app attached; the item must have exactly these many.
             */
            photoCount: number;
        };
        ItemBatchItemInteraction: {
            itemId: components["schemas"]["Id"];
            interaction: components["schemas"]["InteractionTotals"];
        };
        ItemBatchInteractionReplace: {
            batch: components["schemas"]["InteractionTotals"];
            items: components["schemas"]["ItemBatchItemInteraction"][];
        };
        /**
         * @description A model's guess, not market data. `label` is always
         *     "AI estimate - not based on sold listings"; clients show it next to the numbers.
         */
        AiPriceEstimate: {
            label: string;
            low: components["schemas"]["Money"];
            mid: components["schemas"]["Money"];
            high: components["schemas"]["Money"];
            confidence: components["schemas"]["Confidence"];
        };
        /**
         * @description A `KnownSoldDataSource`, or a source of real sold data added after this client was
         *     built. Clients show the comparables' `label` for an unknown source.
         */
        SoldDataSource: components["schemas"]["KnownSoldDataSource"];
        /**
         * @description Sources of real sold data. `ai_estimate` and `cost_floor` are deliberately not in this
         *     list: the words "comps" and "sold" are only ever shown next to real sold data.
         * @enum {string}
         */
        KnownSoldDataSource: "depop_inspiration" | "ebay_mi" | "own_history";
        /** @description Real sold data. Absent from a suggestion when none is available. */
        SoldComparables: {
            source: components["schemas"]["SoldDataSource"];
            /** @description Set when the data may be shown only in that marketplace's listing context. */
            marketplace?: components["schemas"]["Marketplace"];
            /** @description For example "Sold on Depop (last 90 days)". */
            label: string;
            /** Format: int32 */
            sampleSize: number;
            low: components["schemas"]["Money"];
            median: components["schemas"]["Money"];
            high: components["schemas"]["Money"];
            fetchedAt: components["schemas"]["Timestamp"];
        };
        /** @enum {string} */
        PriceTierName: "quick_sale" | "recommended" | "higher_profit";
        /**
         * @description A `KnownPriceBasis`, or a basis added after this client was built. Clients show the
         *     tier's `label` for an unknown basis and never present it as sold data.
         */
        PriceBasis: components["schemas"]["KnownPriceBasis"];
        /**
         * @description What a suggested price is derived from.
         * @enum {string}
         */
        KnownPriceBasis: "sold_data" | "ai_estimate" | "cost_floor";
        PriceTier: {
            tier: components["schemas"]["PriceTierName"];
            price: components["schemas"]["Money"];
            basis: components["schemas"]["PriceBasis"];
            /** @description For example "Recommended (AI estimate)". */
            label: string;
        };
        FloorBreakdown: {
            cost: components["schemas"]["Money"];
            estimatedFees: components["schemas"]["Money"];
            shipping: components["schemas"]["Money"];
            minimumProfit: components["schemas"]["Money"];
        };
        /** @description "Don't sell below": cost + estimated marketplace fees + shipping + the user's minimum profit. */
        MarketplaceFloor: {
            marketplace: components["schemas"]["Marketplace"];
            floorPrice: components["schemas"]["Money"];
            breakdown: components["schemas"]["FloorBreakdown"];
            /** @description The versioned fee table the estimated fees come from. */
            feeTableVersion: string;
            feeSource?: components["schemas"]["FeeEstimateSource"];
        };
        /**
         * @description A `KnownFeeEstimateSource`, or a source added after this client was built. Every
         *     source is an estimate.
         */
        FeeEstimateSource: components["schemas"]["KnownFeeEstimateSource"];
        /**
         * @description `fee_table` is the marketplace's published fee schedule. `actual_fees` is that schedule
         *     scaled to the fees the marketplace actually charged on the account's recent sales.
         * @enum {string}
         */
        KnownFeeEstimateSource: "fee_table" | "actual_fees";
        /** @description A page the user opens in their own browser. Listora does not fetch or scrape it. */
        ResearchLink: {
            label: string;
            /** Format: uri */
            url: string;
        };
        PricingSuggestion: {
            itemId: components["schemas"]["Id"];
            /** @description Absent or empty when there is no real sold data for this item. */
            soldComparables?: components["schemas"]["SoldComparables"][];
            /**
             * @description "No sold data available for this item". Present exactly when there are no
             *     `soldComparables`; clients show it in place of sold data.
             */
            noSoldDataMessage?: string;
            aiEstimate?: components["schemas"]["AiPriceEstimate"];
            /**
             * @description Quick sale, recommended, and higher profit, in that order, each labeled with its
             *     basis. Never below the highest of `floors`. Empty when there is no estimate.
             */
            tiers: components["schemas"]["PriceTier"][];
            /** @description One per marketplace the item is or may be listed on. Empty when the item has no cost. */
            floors: components["schemas"]["MarketplaceFloor"][];
            researchLinks: components["schemas"]["ResearchLink"][];
            generatedAt: components["schemas"]["Timestamp"];
        };
        /**
         * @description A `KnownUsageMetric`, or a quota added after this client was built. Clients show an
         *     unknown metric generically or not at all.
         */
        UsageMetric: components["schemas"]["KnownUsageMetric"];
        /**
         * @description Plan quotas in reseller units. `ai_items`: items analyzed (one per fast analysis).
         *     `premium_identifications`: premium analyses ("Identify harder").
         * @enum {string}
         */
        KnownUsageMetric: "ai_items" | "premium_identifications";
        QuotaUsage: {
            metric: components["schemas"]["UsageMetric"];
            /**
             * Format: int32
             * @description Units used in the period.
             */
            used: number;
            /**
             * Format: int32
             * @description The plan's limit for the period. Absent means unlimited.
             */
            limit?: number;
        };
        Usage: {
            /**
             * Format: date
             * @description First day of the period (UTC).
             */
            periodStart: string;
            /**
             * Format: date
             * @description The day after the period's last day (UTC); quotas reset then.
             */
            periodEnd: string;
            /** @description One per `KnownUsageMetric`, in that order. */
            quotas: components["schemas"]["QuotaUsage"][];
        };
        VoiceCorrectionRequest: {
            /**
             * @description The phrases of the seller's spoken correction that the app's own parser could not
             *     map, as text (on-device speech recognition). Never audio.
             */
            transcript: string;
        };
        VoiceCorrection: {
            /** @description The proposed changes in the order they were said; empty when nothing mapped. */
            changes: components["schemas"]["VoiceCorrectionChange"][];
        };
        /**
         * @description One proposed change. `cost` (what the seller paid) and `listPrice` carry `amount`; every
         *     other field carries `value`: a canonical value for category (`<category>/<subcategory>`),
         *     department, sizeSystem, colors, pattern, materials, and condition, otherwise text. A list
         *     detail gets one change per entry: the colors (or materials) of one answer together
         *     replace the item's, and each keyword or flaw is added to the item's.
         */
        VoiceCorrectionChange: {
            field: components["schemas"]["VoiceCorrectionField"];
            value?: string;
            amount?: components["schemas"]["Money"];
        };
        /**
         * @description A `KnownVoiceCorrectionField`, or a field added after this client was built. Clients
         *     ignore a change to a field they do not know.
         */
        VoiceCorrectionField: components["schemas"]["KnownVoiceCorrectionField"];
        /**
         * @description The item detail a change is for, named like `ItemDetails`; `cost` is what the seller paid
         *     and `purchaseSource` where they bought it.
         * @enum {string}
         */
        KnownVoiceCorrectionField: "title" | "brand" | "productName" | "category" | "department" | "sizeLabel" | "sizeSystem" | "colors" | "pattern" | "materials" | "keywords" | "styleNumber" | "condition" | "conditionNotes" | "flaws" | "cost" | "purchaseSource" | "listPrice";
        /**
         * @description A `KnownListingStatus`, or a status added after this client was built. Clients show
         *     the listing's `statusDisplay` for an unknown status and never treat it as success.
         */
        ListingStatus: components["schemas"]["KnownListingStatus"];
        /**
         * @description Lifecycle of one listing. `active` and `ended` are set only after verification
         *     (see `verification`); `unknown` means an outcome is being checked.
         * @enum {string}
         */
        KnownListingStatus: "draft" | "queued" | "publishing" | "active" | "ending" | "ended" | "sold" | "error" | "unknown" | "needs_user_action";
        /**
         * @description A `KnownListingAction`, or an action added after this client was built. Clients hide
         *     actions they do not know.
         */
        ListingAction: components["schemas"]["KnownListingAction"];
        /** @enum {string} */
        KnownListingAction: "publish" | "revise" | "change_price" | "end" | "relist" | "verify";
        /** @description An action the user can take now, and whether Listora or the user performs it. */
        ListingActionAvailability: {
            action: components["schemas"]["ListingAction"];
            mode: components["schemas"]["IntegrationMode"];
        };
        /** @description A marketplace item specific, for example `{"name": "Sleeve Length", "values": ["Short Sleeve"]}`. */
        ListingAspect: {
            name: string;
            values: string[];
        };
        /** @description The marketplace-specific version of the item. */
        ListingVariant: {
            /** @description Marketplace limits (for example 80 characters on eBay) are checked at publish. */
            title: string;
            description: string;
            price: components["schemas"]["Money"];
            /** @description The marketplace's category id. */
            categoryRef?: string;
            condition?: components["schemas"]["ItemCondition"];
            aspects?: components["schemas"]["ListingAspect"][];
            hashtags?: string[];
        };
        ListingCreate: {
            marketplace: components["schemas"]["KnownMarketplace"];
            variant: components["schemas"]["ListingVariant"];
        };
        /**
         * @description A marketplace listing URL as the user shared it. Accepted: listing pages on
         *     `ebay.com` (`/itm/<item id>`), `poshmark.com` (`/listing/<title>-<id>`),
         *     `mercari.com` (`/us/item/<id>/`), and `depop.com` (`/products/<slug>/`), and the
         *     marketplaces' share short links (`ebay.us`, `posh.mk`, `merc.li`, `depop.app.link`).
         *     The server keeps the canonical form (https, no query or fragment) as the listing's
         *     `externalUrl`, and the listing id as `externalListingId`; a short link has no
         *     listing id, because only the marketplace can resolve it and Listora never fetches it.
         */
        SharedListingUrl: string;
        ListingLinkCreate: {
            url: components["schemas"]["SharedListingUrl"];
        };
        SharedListingImport: {
            url: components["schemas"]["SharedListingUrl"];
            /** @description The new item's title, entered or confirmed by the user. */
            title: string;
        };
        SharedListingImportResult: {
            item: components["schemas"]["Item"];
            listing: components["schemas"]["Listing"];
        };
        ListingVariantReplace: {
            variant: components["schemas"]["ListingVariant"];
        };
        ListingPriceChange: {
            price: components["schemas"]["Money"];
        };
        /** @enum {string} */
        ListingEndReason: "sold_elsewhere" | "not_available" | "other";
        ListingEnd: {
            reason: components["schemas"]["ListingEndReason"];
        };
        /**
         * @description One item's listing on one marketplace. `variant` is Listora's version of the listing;
         *     it is absent for a listing the user linked from a share (`linkItemListing`), because
         *     Listora never read that listing's title or price.
         */
        Listing: {
            id: components["schemas"]["Id"];
            itemId: components["schemas"]["Id"];
            marketplace: components["schemas"]["Marketplace"];
            mode: components["schemas"]["IntegrationMode"];
            status: components["schemas"]["ListingStatus"];
            statusDisplay: components["schemas"]["StatusDisplay"];
            verification?: components["schemas"]["Verification"];
            externalListingId?: string;
            externalSku?: string;
            /** Format: uri */
            externalUrl?: string;
            variant?: components["schemas"]["ListingVariant"];
            latestOperation?: components["schemas"]["Operation"];
            availableActions: components["schemas"]["ListingActionAvailability"][];
            listedAt?: components["schemas"]["Timestamp"];
            endedAt?: components["schemas"]["Timestamp"];
            lastVerifiedAt?: components["schemas"]["Timestamp"];
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
        };
        ListingStatusSummary: {
            listingId: components["schemas"]["Id"];
            marketplace: components["schemas"]["Marketplace"];
            mode: components["schemas"]["IntegrationMode"];
            status: components["schemas"]["ListingStatus"];
            statusDisplay: components["schemas"]["StatusDisplay"];
        };
        ListingList: {
            data: components["schemas"]["Listing"][];
        };
        ListingPage: {
            data: components["schemas"]["Listing"][];
            /** @description Present when there are more results. */
            nextCursor?: string;
        };
        ListingOperationAccepted: {
            listing: components["schemas"]["Listing"];
            operation: components["schemas"]["Operation"];
        };
        /**
         * @description A `KnownOperationKind`, or a kind added after this client was built. Clients describe
         *     an unknown kind generically using the operation's `statusDisplay`.
         */
        OperationKind: components["schemas"]["KnownOperationKind"];
        /** @enum {string} */
        KnownOperationKind: "create" | "revise" | "price" | "end" | "relist" | "mark_sold" | "verify";
        /**
         * @description A `KnownOperationStatus`, or a status added after this client was built. Clients show
         *     the operation's `statusDisplay` for an unknown status and never treat it as success.
         */
        OperationStatus: components["schemas"]["KnownOperationStatus"];
        /**
         * @description `succeeded` only after an API read-back confirms the desired state or the user
         *     confirms an assisted task. `verifying`: the outcome is unknown (for example a timeout
         *     after sending) and is being checked by read-back; the request is never re-sent
         *     blindly. `retrying`: a transient failure, retried with backoff.
         * @enum {string}
         */
        KnownOperationStatus: "queued" | "running" | "retrying" | "verifying" | "succeeded" | "failed" | "needs_user_action" | "canceled";
        /**
         * @description A `KnownOperationOriginType`, or an origin added after this client was built. Clients
         *     show an unknown origin generically.
         */
        OperationOriginType: components["schemas"]["KnownOperationOriginType"];
        /** @enum {string} */
        KnownOperationOriginType: "user" | "auto_delist" | "reprice_rule";
        OperationOrigin: {
            type: components["schemas"]["OperationOriginType"];
            /** @description Set for `auto_delist`. */
            saleId?: components["schemas"]["Id"];
            /** @description Set for `reprice_rule`. */
            repriceRuleId?: components["schemas"]["Id"];
        };
        OperationError: {
            /** @description Listora's normalized error code, for example `marketplace_validation`. */
            code: string;
            /** @description User-readable reason. */
            message: string;
            /** @description What the user can do about it. */
            fixHint?: string;
            retryable: boolean;
            /** @description The marketplace's own error code, for support. */
            marketplaceErrorCode?: string;
        };
        Operation: {
            id: components["schemas"]["Id"];
            listingId: components["schemas"]["Id"];
            itemId: components["schemas"]["Id"];
            marketplace: components["schemas"]["Marketplace"];
            kind: components["schemas"]["OperationKind"];
            status: components["schemas"]["OperationStatus"];
            statusDisplay: components["schemas"]["StatusDisplay"];
            /**
             * Format: int32
             * @description Attempts made so far (shown as "retry 2 of 6").
             */
            attempt: number;
            /** Format: int32 */
            maxAttempts: number;
            nextAttemptAt?: components["schemas"]["Timestamp"];
            origin: components["schemas"]["OperationOrigin"];
            error?: components["schemas"]["OperationError"];
            verification?: components["schemas"]["Verification"];
            /** @description The assisted task this operation waits for. */
            userTaskId?: components["schemas"]["Id"];
            retryOfOperationId?: components["schemas"]["Id"];
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
            completedAt?: components["schemas"]["Timestamp"];
        };
        OperationPage: {
            data: components["schemas"]["Operation"][];
            /** @description Present when there are more results. */
            nextCursor?: string;
        };
        /** @description One state transition. Append-only. */
        OperationEvent: {
            id: components["schemas"]["Id"];
            operationId: components["schemas"]["Id"];
            /** Format: int64 */
            sequence: number;
            /** @description Absent for the first event. */
            fromStatus?: components["schemas"]["OperationStatus"];
            toStatus: components["schemas"]["OperationStatus"];
            /** Format: int32 */
            attempt: number;
            /** @description User-readable summary, for example "eBay confirmed the new price". */
            message?: string;
            error?: components["schemas"]["OperationError"];
            /** @description Redacted request/response excerpt for support views. Never contains tokens. */
            detail?: {
                [key: string]: unknown;
            };
            occurredAt: components["schemas"]["Timestamp"];
        };
        OperationEventPage: {
            data: components["schemas"]["OperationEvent"][];
            /** @description Present when there are more results. */
            nextCursor?: string;
        };
        /**
         * @description A `KnownConnectionStatus`, or a status added after this client was built. Clients
         *     show the connection's `statusDisplay` for an unknown status.
         */
        ConnectionStatus: components["schemas"]["KnownConnectionStatus"];
        /**
         * @description State of the API connection. Assisted marketplaces (`mode: assisted`) have no account
         *     connection and report `not_connected`; their `statusDisplay` says so.
         * @enum {string}
         */
        KnownConnectionStatus: "not_connected" | "connected" | "degraded" | "reauth_required" | "revoked";
        /**
         * @description A `KnownCapabilityMode`, or a mode added after this client was built. Clients treat
         *     an unknown mode like `none` (the capability is not offered).
         */
        CapabilityMode: components["schemas"]["KnownCapabilityMode"];
        /**
         * @description `api`: through the marketplace's API. `automation`: by Listora's browser runner or the
         *     seller's iPhone, in the seller's session. `assisted`: by the user. `bulk_file`: by a file the seller uploads.
         *     `none`: not offered.
         * @enum {string}
         */
        KnownCapabilityMode: "api" | "automation" | "assisted" | "bulk_file" | "none";
        /**
         * @description A `KnownMarkSoldMode`, or a mode added after this client was built. Clients treat an
         *     unknown mode like `none`.
         */
        MarkSoldMode: components["schemas"]["KnownMarkSoldMode"];
        /** @enum {string} */
        KnownMarkSoldMode: "api" | "automation" | "assisted" | "bulk_file" | "none" | "not_needed";
        /**
         * @description A `KnownConnectMethod`, or a method added after this client was built. Clients treat
         *     an unknown method like `none` (no connect button).
         */
        ConnectMethod: components["schemas"]["KnownConnectMethod"];
        /**
         * @description `oauth`: the seller authorizes Listora on the marketplace. `session`: the seller logs into
         *     the marketplace in the app, and Listora keeps the session's cookies (never the password)
         *     for its browser runner. `none`: nothing to connect.
         * @enum {string}
         */
        KnownConnectMethod: "oauth" | "session" | "none";
        /**
         * @description A `KnownVerifyReadMode`, or a mode added after this client was built. Clients offer no
         *     "check again" action for an unknown mode.
         */
        VerifyReadMode: components["schemas"]["KnownVerifyReadMode"];
        /**
         * @description How success is established: a read-back through the API, a read-back through the
         *     automated browser session, or the user's confirmation.
         * @enum {string}
         */
        KnownVerifyReadMode: "api" | "automation" | "user_confirm";
        /**
         * @description A `KnownImportListingsMode`, or a mode added after this client was built. Clients
         *     treat an unknown mode like `none`.
         */
        ImportListingsMode: components["schemas"]["KnownImportListingsMode"];
        /** @enum {string} */
        KnownImportListingsMode: "api" | "share_sheet" | "bulk_file" | "none";
        /**
         * @description A `KnownImageTransportMode`, or a mode added after this client was built. Clients
         *     treat an unknown mode like `user_saves_photos`.
         */
        ImageTransportMode: components["schemas"]["KnownImageTransportMode"];
        /** @enum {string} */
        KnownImageTransportMode: "url_fetch" | "upload" | "user_saves_photos";
        /**
         * @description What Listora can do on this marketplace for this account. Clients branch on these
         *     flags, never on the marketplace name; they can change when access is granted.
         */
        MarketplaceCapabilities: {
            connect: components["schemas"]["ConnectMethod"];
            create: components["schemas"]["CapabilityMode"];
            updatePrice: components["schemas"]["CapabilityMode"];
            updateDetails: components["schemas"]["CapabilityMode"];
            delist: components["schemas"]["CapabilityMode"];
            relist: components["schemas"]["CapabilityMode"];
            markSold: components["schemas"]["MarkSoldMode"];
            verifyRead: components["schemas"]["VerifyReadMode"];
            importListings: components["schemas"]["ImportListingsMode"];
            saleDetection: components["schemas"]["SaleDetectionSource"][];
            imageTransport: components["schemas"]["ImageTransportMode"];
        };
        ConnectionIssue: {
            code: string;
            message: string;
            occurredAt: components["schemas"]["Timestamp"];
        };
        /**
         * @description A `KnownConnectionAction`, or an action added after this client was built. Clients hide
         *     actions they do not know.
         */
        ConnectionAction: components["schemas"]["KnownConnectionAction"];
        /**
         * @description `connect`: start `startConnectionAuthorization` for a marketplace not connected yet.
         *     `reconnect`: the same, for a connection that needs the seller's consent again (its grant
         *     was revoked, expires within 30 days, or fails); it renews the existing connection.
         *     `check`: `requestConnectionCheck` (Retry check), for a connection with a problem
         *     Listora may have cleared since, or an automation connection whose sign-in is not
         *     confirmed.
         * @enum {string}
         */
        KnownConnectionAction: "connect" | "reconnect" | "check";
        Connection: {
            marketplace: components["schemas"]["Marketplace"];
            mode: components["schemas"]["IntegrationMode"];
            status: components["schemas"]["ConnectionStatus"];
            statusDisplay: components["schemas"]["StatusDisplay"];
            capabilities: components["schemas"]["MarketplaceCapabilities"];
            /** @description What the user can do about the connection now; empty when nothing. */
            availableActions: components["schemas"]["ConnectionAction"][];
            /** @description The seller's name on the marketplace. */
            displayName?: string;
            connectedAt?: components["schemas"]["Timestamp"];
            /** @description When the user must reconnect (Depop grants last one year; eBay refresh tokens about 18 months). */
            grantExpiresAt?: components["schemas"]["Timestamp"];
            /** @description When the marketplace last accepted Listora's access (the last successful check). */
            lastOkAt?: components["schemas"]["Timestamp"];
            /** @description When Listora last checked the connection, whatever it found. */
            lastCheckedAt?: components["schemas"]["Timestamp"];
            lastIssue?: components["schemas"]["ConnectionIssue"];
            execution?: components["schemas"]["ConnectionExecution"];
        };
        ConnectionList: {
            data: components["schemas"]["Connection"][];
        };
        /** @enum {string} */
        ConnectionAuthorizationStatus: "pending" | "completed" | "failed" | "expired";
        ConnectionAuthorization: {
            id: components["schemas"]["Id"];
            marketplace: components["schemas"]["Marketplace"];
            status: components["schemas"]["ConnectionAuthorizationStatus"];
            /**
             * Format: uri
             * @description The marketplace's own consent page. Only in the `startConnectionAuthorization`
             *     response (and its replays): it carries the attempt's single-use `state`, which
             *     Listora keeps only as a hash.
             */
            authorizationUrl?: string;
            /** @description The URL scheme `ASWebAuthenticationSession` waits for (`listora`). */
            callbackUrlScheme: string;
            expiresAt: components["schemas"]["Timestamp"];
            /** @description Present when `status` is `failed`. */
            failure?: components["schemas"]["ApiError"];
            /** @description Present when `status` is `completed`. */
            connection?: components["schemas"]["Connection"];
            createdAt: components["schemas"]["Timestamp"];
            completedAt?: components["schemas"]["Timestamp"];
        };
        /**
         * @description A `KnownConnectionAttentionReason`, or a reason added after this client was built.
         *     Clients show the entry's `statusDisplay` for an unknown reason.
         */
        ConnectionAttentionReason: components["schemas"]["KnownConnectionAttentionReason"];
        /**
         * @description `reconnect`: the marketplace no longer accepts Listora's access (`reauth_required`).
         *     `access_removed`: the access was revoked (`revoked`). `connection_problem`: Listora
         *     cannot reach the marketplace now and keeps checking (`degraded`). `expiring`: the grant
         *     ends within 30 days. `not_confirmed`: Listora could not confirm that the marketplace
         *     accepts the sign-in linked for automation (its check failed or did not finish); the
         *     `check` action checks it again.
         * @enum {string}
         */
        KnownConnectionAttentionReason: "reconnect" | "access_removed" | "connection_problem" | "expiring" | "not_confirmed";
        /** @description One connection that needs the seller's attention. */
        ConnectionAttention: {
            marketplace: components["schemas"]["Marketplace"];
            reason: components["schemas"]["ConnectionAttentionReason"];
            /** @description The connection's own status, as in `Connection.statusDisplay`. */
            statusDisplay: components["schemas"]["StatusDisplay"];
        };
        /**
         * @description A `KnownSaleForwardingStatus`, or a status added after this client was built. Clients
         *     show the `statusDisplay`.
         */
        SaleForwardingStatus: components["schemas"]["KnownSaleForwardingStatus"];
        /**
         * @description - `needs_domain`: forwarding marketplace sale emails to Listora needs Listora's inbound
         *       email domain, which this deployment does not have yet.
         *     - `not_set_up`, `confirming`, `working`: as `KnownSaleEmailStatus` (`getSaleEmails`, which
         *       has the address and the setup steps).
         * @enum {string}
         */
        KnownSaleForwardingStatus: "needs_domain" | "not_set_up" | "confirming" | "working";
        /** @description Forwarding marketplace sale emails to Listora, which detects sales sooner. */
        SaleForwarding: {
            status: components["schemas"]["SaleForwardingStatus"];
            statusDisplay: components["schemas"]["StatusDisplay"];
        };
        ConnectionHealthSummary: {
            /** @description True while any connection is in `attention`; the app shows `banner` then. */
            needsAttention: boolean;
            /** @description Present exactly when `needsAttention`. */
            banner?: components["schemas"]["StatusDisplay"];
            /** @description The connections that need attention, those only the seller can fix first. */
            attention: components["schemas"]["ConnectionAttention"][];
            /** @description Every marketplace and its connection, as `listConnections` returns them. */
            connections: components["schemas"]["Connection"][];
            saleForwarding: components["schemas"]["SaleForwarding"];
            /** @description The latest check of any connection; absent before the first. */
            lastCheckedAt?: components["schemas"]["Timestamp"];
        };
        /**
         * @description A `KnownMarketplaceSessionStatus`, or a status added after this client was built.
         *     Clients show `statusDisplay` for an unknown status and offer to link again.
         */
        MarketplaceSessionStatus: components["schemas"]["KnownMarketplaceSessionStatus"];
        /**
         * @description `not_linked`: no session. `checking`: a session was just linked (or checked again) and
         *     Listora is checking it where the marketplace runs (the browser runner, for at most 15
         *     minutes, or the seller's iPhone, the next time Listora runs there). `linked`: the check passed,
         *     and Listora automates the marketplace in that session. `needs_relink`: the marketplace
         *     rejected the session, or showed a check automation must not pass; the user signs in
         *     again. `check_failed`: Listora could not confirm the session works: its check failed or
         *     did not finish in time (see `issue`). `requestConnectionCheck` checks the same session
         *     again; linking again checks a new one. `api_connected`: the marketplace is connected
         *     through its API, so there is nothing to sign in to. The marketplace's `Connection` shows
         *     the same status in the same words.
         * @enum {string}
         */
        KnownMarketplaceSessionStatus: "not_linked" | "checking" | "linked" | "needs_relink" | "check_failed" | "api_connected";
        /** @description Where the app signs the user in, and which of that site's cookies it hands over. */
        MarketplaceSessionLogin: {
            /**
             * Format: uri
             * @description The marketplace's own sign-in page.
             */
            url: string;
            /**
             * @description The marketplace's own domains (`poshmark.com`). The app sends only cookies whose
             *     domain is one of these or a subdomain of one; the server refuses any other.
             */
            cookieDomains: string[];
        };
        /**
         * @description A marketplace linked by signing in (`connect: session`). It is shown as linked only
         *     after the session check (on the browser runner or the seller's iPhone) confirmed the
         *     marketplace accepts the session.
         */
        MarketplaceSession: {
            marketplace: components["schemas"]["Marketplace"];
            status: components["schemas"]["MarketplaceSessionStatus"];
            statusDisplay: components["schemas"]["StatusDisplay"];
            login: components["schemas"]["MarketplaceSessionLogin"];
            /** @description The seller's name on the marketplace, when the app or the check knows it. */
            displayName?: string;
            /** @description When the current session was linked. */
            linkedAt?: components["schemas"]["Timestamp"];
            /** @description When the current session's check finished. */
            checkedAt?: components["schemas"]["Timestamp"];
            /** @description Why the session needs relinking, or why its check failed. */
            issue?: components["schemas"]["ConnectionIssue"];
            /** @description Where its automated steps run; present once it is linked. */
            execution?: components["schemas"]["ConnectionExecution"];
        };
        MarketplaceSessionList: {
            data: components["schemas"]["MarketplaceSession"][];
        };
        /**
         * @description One cookie as the app's web view holds it (`HTTPCookie`), in the browser runner's
         *     terms. A name plus value of at most 4096 bytes, as browsers allow.
         */
        SessionCookie: {
            name: string;
            value: string;
            /** @description A host (`www.poshmark.com`) or a domain cookie (`.poshmark.com`). */
            domain: string;
            path: string;
            /**
             * Format: int64
             * @description Unix time in whole seconds; `-1` for a cookie that lasts as long as the browser session.
             */
            expires: number;
            httpOnly: boolean;
            secure: boolean;
            /**
             * @description `lax` when the site set none.
             * @enum {string}
             */
            sameSite: "strict" | "lax" | "none";
        };
        MarketplaceSessionLink: {
            /** @description The marketplace's cookies after the user signed in, and no other site's. */
            cookies: components["schemas"]["SessionCookie"][];
            /** @description The seller's name on the marketplace, when the app knows it. */
            displayName?: string;
            /**
             * @description The registered device that linked it (`registerDevice`), which then runs the
             *     marketplace's automated steps when they run on the phone.
             */
            installationId?: components["schemas"]["Id"];
        };
        /** @description A `KnownExecutionLocation`, or a location added after this client was built. */
        ExecutionLocation: components["schemas"]["KnownExecutionLocation"];
        /**
         * @description Where a connection's automated steps run: `cloud`, Listora's browser runner; `phone`, the
         *     iPhone that linked the marketplace, in the seller's own session on their own network.
         * @enum {string}
         */
        KnownExecutionLocation: "cloud" | "phone";
        /**
         * @description Where the connection's automated steps run, and what waits for the phone. Present for a
         *     marketplace that is automated in a linked session.
         */
        ConnectionExecution: {
            location: components["schemas"]["ExecutionLocation"];
            /**
             * @description What to show: `Runs on your iPhone` or `Runs in Listora's cloud`, or why the phone
             *     can't run it yet (`Link it on your iPhone to run it there`).
             */
            label: string;
            /** @description The phone that runs it, when it runs on one (compare with your own). */
            deviceInstallationId?: components["schemas"]["Id"];
            deviceName?: string;
            /**
             * Format: int32
             * @description Changes and checks waiting for that phone to run them.
             */
            waiting?: number;
            /** @description Since when the oldest of them waits. */
            waitingSince?: components["schemas"]["Timestamp"];
        };
        ConnectionExecutionChange: {
            location: components["schemas"]["KnownExecutionLocation"];
        };
        /** @enum {string} */
        DevicePlatform: "ios";
        /**
         * @description The APNs environment the device token belongs to.
         * @enum {string}
         */
        PushEnvironment: "sandbox" | "production";
        DeviceRegistration: {
            /** @description The device's name, as the seller sees it ("Tonio's iPhone"). */
            name: string;
            platform: components["schemas"]["DevicePlatform"];
            appVersion?: string;
            /**
             * Format: int32
             * @description The version of phone calls the app's runtime speaks.
             */
            runtimeVersion?: number;
            /** @description The APNs device token, hex; absent when the app has none. */
            pushToken?: string;
            pushEnvironment?: components["schemas"]["PushEnvironment"];
        };
        Device: {
            installationId: components["schemas"]["Id"];
            name: string;
            platform: components["schemas"]["DevicePlatform"];
            /** @description Whether Listora can send this device push notifications. */
            pushEnabled: boolean;
            lastSeenAt: components["schemas"]["Timestamp"];
        };
        /** @description A `KnownPhoneWorkPurpose`, or one added after this client was built. */
        PhoneWorkPurpose: components["schemas"]["KnownPhoneWorkPurpose"];
        /**
         * @description `operation`: one step of a listing change (a publish, a price change, a delist, a relist,
         *     or its read-back). `session_check`: the check that a linked sign-in works. `sale_check`:
         *     a look at the seller's sold orders.
         * @enum {string}
         */
        KnownPhoneWorkPurpose: "operation" | "session_check" | "sale_check";
        PhoneRunClaim: {
            installationId: components["schemas"]["Id"];
            /** Format: int32 */
            runtimeVersion: number;
        };
        /**
         * @description One script call for the phone runtime: its `input` goes to `listoraPhone.run` unchanged,
         *     and its result comes back as `answerPhoneCall`'s `answer`. Its shape is the runtime's
         *     (`PhoneCallInput` in packages/automation/src/phone/runtime.ts), versioned by
         *     `runtimeVersion`.
         */
        PhoneCall: {
            /** Format: int32 */
            index: number;
            input: {
                [key: string]: unknown;
            };
        };
        /**
         * @description The phone's run of one piece of work. While it has a `call`, the phone runs it and
         *     answers; without one, the run is over and the phone claims the next.
         */
        PhoneRun: {
            id: components["schemas"]["Id"];
            purpose: components["schemas"]["PhoneWorkPurpose"];
            marketplace: components["schemas"]["Marketplace"];
            operationId?: components["schemas"]["Id"];
            call?: components["schemas"]["PhoneCall"];
        };
        /** @description The run to continue, absent when there is nothing (more) to run. */
        PhoneRunResult: {
            run?: components["schemas"]["PhoneRun"];
        };
        PhoneCallAnswer: {
            installationId: components["schemas"]["Id"];
            /** @description What `listoraPhone.run` returned (`PhoneCallOutput`), unchanged. */
            answer: {
                [key: string]: unknown;
            };
        };
        /**
         * @description A `KnownSaleStatus`, or a status added after this client was built. Clients show an
         *     unknown status generically.
         */
        SaleStatus: components["schemas"]["KnownSaleStatus"];
        /**
         * @description `detected`: Listora recorded the sale (from the marketplace, or "Mark sold").
         *     `confirmed`: the seller confirmed it. `shipped`: the seller shipped it. `canceled` and
         *     `returned`: the sale no longer stands; Listora asks whether to relist (`SaleItem.relist`).
         * @enum {string}
         */
        KnownSaleStatus: "detected" | "confirmed" | "shipped" | "canceled" | "returned";
        /**
         * @description A `KnownSaleDetectionSource`, or a source added after this client was built. Clients
         *     show an unknown source generically.
         */
        SaleDetectionSource: components["schemas"]["KnownSaleDetectionSource"];
        /** @enum {string} */
        KnownSaleDetectionSource: "webhook" | "poll" | "email" | "manual";
        /**
         * @description `completed`: every other listing is delisted (confirmed by the marketplace's read-back)
         *     or done (the user confirmed). `needs_attention`: a delist failed, waits for the user, or
         *     was canceled. `in_progress`: Listora is still delisting or checking.
         * @enum {string}
         */
        DelistRunStatus: "in_progress" | "completed" | "needs_attention";
        /**
         * @description A `KnownDelistResultState`, or a state added after this client was built. Clients
         *     show the result's `statusDisplay` for an unknown state and never treat it as delisted.
         */
        DelistResultState: components["schemas"]["KnownDelistResultState"];
        /**
         * @description `delisted`: a read-back of the marketplace confirmed it. `user_confirmed`: the user
         *     confirmed an assisted delist. Only these two count as done. `pending`: delisting or
         *     waiting to retry. `verifying`: the outcome is unknown and is being read back.
         *     `needs_user_action`: the user has to delist it in the marketplace's app. `failed`: shows
         *     the reason and a Retry. `canceled`: Listora stopped delisting it (the listing may still
         *     be live).
         * @enum {string}
         */
        KnownDelistResultState: "pending" | "verifying" | "delisted" | "user_confirmed" | "needs_user_action" | "failed" | "canceled";
        /** @description One listing of the sold item on another marketplace, and its delist. */
        DelistResult: {
            listingId: components["schemas"]["Id"];
            marketplace: components["schemas"]["Marketplace"];
            mode: components["schemas"]["IntegrationMode"];
            state: components["schemas"]["DelistResultState"];
            /** @description For example `Delisted (confirmed by eBay)`, `Delisting... retry 2 of 6`, or `Done (you confirmed)`. */
            statusDisplay: components["schemas"]["StatusDisplay"];
            /** @description The delist operation; Retry a `failed` one with `retryOperation`. */
            operationId: components["schemas"]["Id"];
            /**
             * Format: int32
             * @description Attempts made so far (shown as "retry 2 of 6").
             */
            attempt: number;
            /** Format: int32 */
            maxAttempts: number;
            /** @description The assisted delist's task, which the user completes once they delisted it. */
            userTaskId?: components["schemas"]["Id"];
            updatedAt: components["schemas"]["Timestamp"];
        };
        /**
         * @description The automatic delist of one sold item's other listings after a sale (a bundle starts one
         *     run per item). `results` has one entry per listing on another marketplace that may have
         *     been live; a listing that was already ended, sold, or never published needs none.
         */
        DelistRun: {
            id: components["schemas"]["Id"];
            saleId: components["schemas"]["Id"];
            itemId: components["schemas"]["Id"];
            /** @description The marketplace the item sold on. */
            soldOn: components["schemas"]["Marketplace"];
            status: components["schemas"]["DelistRunStatus"];
            /** @description The run in one line, for example `Delisted everywhere` or `Action needed - delist on Poshmark`. */
            statusDisplay: components["schemas"]["StatusDisplay"];
            results: components["schemas"]["DelistResult"][];
            /**
             * @description True while the run is not completed 30 minutes after the sale. The app shows a
             *     banner on the home screen until it completes.
             */
            escalated: boolean;
            startedAt: components["schemas"]["Timestamp"];
            /** @description When the user was alerted again because a listing was still not delisted or confirmed 10 minutes after the sale. */
            realertedAt?: components["schemas"]["Timestamp"];
            /** @description When the alert escalated, 30 minutes after the sale. */
            escalatedAt?: components["schemas"]["Timestamp"];
            completedAt?: components["schemas"]["Timestamp"];
        };
        /**
         * @description A double sale: an item that had already sold sold again in this order. Listora cannot
         *     cancel an order, so the user cancels one of them on its marketplace (`steps`, starting at
         *     `cancelUrl`) and then completes the task (`taskId`).
         */
        DoubleSale: {
            taskId: components["schemas"]["Id"];
            /** @description The later sale, whose order the steps cancel. */
            saleId: components["schemas"]["Id"];
            itemId: components["schemas"]["Id"];
            /** @description The later sale's marketplace. */
            marketplace: components["schemas"]["Marketplace"];
            earlierSaleId: components["schemas"]["Id"];
            earlierMarketplace: components["schemas"]["Marketplace"];
            /** @description For example "Cancel the order on Depop". */
            title: string;
            steps: string[];
            /**
             * Format: uri
             * @description Where the marketplace shows the seller's orders.
             */
            cancelUrl: string;
            status: components["schemas"]["UserTaskStatus"];
            createdAt: components["schemas"]["Timestamp"];
            resolvedAt?: components["schemas"]["Timestamp"];
        };
        /**
         * @description One item of an order. For a bundle, the order's shipping, order-level fees, and
         *     shipping cost are split across its items in proportion to each item's `salePrice`.
         */
        SaleItem: {
            itemId: components["schemas"]["Id"];
            sku: string;
            title?: string;
            /** @description The listing the item sold through, when known. Absent for a sale recorded without one. */
            listingId?: components["schemas"]["Id"];
            /** @description This item's part of the order's sale price (for a bundle, its share of the bundle price). */
            salePrice: components["schemas"]["Money"];
            /** @description What the item cost the seller. Absent when they never entered it. */
            cost?: components["schemas"]["Money"];
            /** @description This item's share of the sale's fees. Absent until the sale has fee lines. */
            fees?: components["schemas"]["Money"];
            /** @description This item's share of the payout. */
            netProceeds?: components["schemas"]["Money"];
            /** @description This item's share of the payout minus its share of `shippingCost` minus its `cost`. */
            profit?: components["schemas"]["Money"];
            /**
             * Format: int64
             * @description `profit` over `cost` in basis points (12550 is 125.5%). Absent without a profit or for a zero cost.
             */
            roiBasisPoints?: number;
            relist?: components["schemas"]["SaleRelist"];
        };
        /** @description One item of a sale recorded by hand. */
        SaleCreateItem: {
            itemId: components["schemas"]["Id"];
            /** @description The item's listing on the sale's marketplace; defaults to its newest one there. */
            listingId?: components["schemas"]["Id"];
            /** @description What this item sold for, before shipping. */
            salePrice: components["schemas"]["Money"];
        };
        /**
         * @description A `KnownSaleAction`, or an action added after this client was built. Clients hide
         *     actions they do not know.
         */
        SaleAction: components["schemas"]["KnownSaleAction"];
        /**
         * @description `confirm` (`confirmSale`), `mark_shipped` (`markSaleShipped`), `cancel` (`cancelSale`),
         *     `record_return` (`recordSaleReturn`).
         * @enum {string}
         */
        KnownSaleAction: "confirm" | "mark_shipped" | "cancel" | "record_return";
        /** @description A `KnownRelistDecision`, or a decision added after this client was built. */
        RelistDecision: components["schemas"]["KnownRelistDecision"];
        /**
         * @description `pending`: the sale was canceled or returned and the seller has not decided yet whether
         *     to relist the item. `relisted`: the seller chose marketplaces to relist on (each relist
         *     is an operation; see the item's listings). `declined`: the seller chose not to relist.
         * @enum {string}
         */
        KnownRelistDecision: "pending" | "relisted" | "declined";
        /** @description One of the item's listings, and whether Listora can relist it now. */
        RelistOption: {
            listingId: components["schemas"]["Id"];
            marketplace: components["schemas"]["Marketplace"];
            /** @description `api`: Listora relists it. `assisted`: the user relists it in the marketplace's app. */
            mode: components["schemas"]["IntegrationMode"];
            /** @description The listing's status now, for example `Delisted (confirmed by eBay)` or `Active (confirmed by Depop)`. */
            statusDisplay: components["schemas"]["StatusDisplay"];
            /**
             * @description False while the listing is still live or a change on it is still running; the
             *     seller can relist it from the item later.
             */
            canRelist: boolean;
        };
        /**
         * @description Present once the sale was canceled or returned and the item has no other sale that
         *     stands. Listora never relists by itself: it asks, and relists only where the user
         *     chooses (`decideSaleRelist`).
         */
        SaleRelist: {
            decision: components["schemas"]["RelistDecision"];
            /** @description The item's newest listing on each marketplace. */
            options: components["schemas"]["RelistOption"][];
            decidedAt?: components["schemas"]["Timestamp"];
        };
        SaleShipment: {
            /** @description What the seller paid for the label outside the payout, when known. */
            shippingCost?: components["schemas"]["Money"];
        };
        SaleRelistChoice: {
            /** @description One entry per item to decide for. */
            items: components["schemas"]["SaleRelistItemChoice"][];
        };
        /** @description One item's answer; an empty `listingIds` means "don't relist". */
        SaleRelistItemChoice: {
            itemId: components["schemas"]["Id"];
            /** @description The listings to relist, from the item's `relist.options` with `canRelist`. */
            listingIds: components["schemas"]["Id"][];
        };
        /** @enum {string} */
        KnownFeeType: "marketplace" | "payment" | "shipping_label" | "promotion" | "tax" | "other";
        /**
         * @description A `KnownFeeType`, or a type added after this client was built. Clients show an unknown
         *     type like `other`.
         */
        FeeType: components["schemas"]["KnownFeeType"];
        /**
         * @description `actual`: reported by the marketplace. `estimated`: from Listora's fee table until the marketplace reports the actual fee.
         * @enum {string}
         */
        FeeSource: "actual" | "estimated";
        /** @description One fee deducted from the sale. */
        FeeLine: {
            type: components["schemas"]["FeeType"];
            /** @description A positive amount the seller pays. */
            amount: components["schemas"]["Money"];
            source: components["schemas"]["FeeSource"];
            /** @description What the marketplace or Listora's fee table calls it, for example "Final value fee". */
            description?: string;
            /** @description For an estimated fee, the fee table it was computed with (for example `ebay-us-2026-10-24`). */
            feeTableVersion?: string;
        };
        SaleCreate: {
            marketplace: components["schemas"]["KnownMarketplace"];
            /** @description The items of the order, each at most once; more than one for a bundle. */
            items: components["schemas"]["SaleCreateItem"][];
            shippingCharged?: components["schemas"]["Money"];
            /** @description Defaults to now. */
            soldAt?: components["schemas"]["Timestamp"];
            externalOrderId?: string;
        };
        /**
         * @description One marketplace order. It has one or more items (a bundle has several). Money values
         *     that depend on fees are absent until they are known.
         */
        Sale: {
            id: components["schemas"]["Id"];
            marketplace: components["schemas"]["Marketplace"];
            externalOrderId?: string;
            items: components["schemas"]["SaleItem"][];
            soldAt: components["schemas"]["Timestamp"];
            /** @description The order's sale price before fees, the sum of `items[].salePrice`. */
            salePrice: components["schemas"]["Money"];
            /** @description What the buyer paid for shipping. */
            shippingCharged?: components["schemas"]["Money"];
            /**
             * @description Every fee deducted from the payout. Estimated from Listora's fee table when the sale
             *     is recorded, and replaced by the marketplace's actual fees once it reports them.
             *     Absent for a sale without fee lines.
             */
            fees?: components["schemas"]["FeeLine"][];
            /** @description True while any fee is an estimate; `netProceeds` and `profit` are estimates then too. */
            feesEstimated?: boolean;
            /**
             * @description What the seller paid to ship outside the payout, for example a label bought
             *     separately. A label the marketplace deducts is a `shipping_label` fee instead.
             */
            shippingCost?: components["schemas"]["Money"];
            /** @description The payout, `salePrice` plus `shippingCharged` minus `fees`. Absent until the fees are known. */
            netProceeds?: components["schemas"]["Money"];
            /**
             * @description `netProceeds` minus `shippingCost` minus the items' `cost`. Absent until
             *     `netProceeds` is known and every item has a cost.
             */
            profit?: components["schemas"]["Money"];
            /** @description The items' total cost. Absent when an item has none. */
            cost?: components["schemas"]["Money"];
            /**
             * Format: int64
             * @description `profit` over `cost` in basis points. Absent without a profit or for a zero cost.
             */
            roiBasisPoints?: number;
            detectionSource: components["schemas"]["SaleDetectionSource"];
            status: components["schemas"]["SaleStatus"];
            shipBy?: components["schemas"]["Timestamp"];
            /** @description What the seller can do with the sale now, in display order. */
            availableActions: components["schemas"]["SaleAction"][];
            confirmedAt?: components["schemas"]["Timestamp"];
            shippedAt?: components["schemas"]["Timestamp"];
            canceledAt?: components["schemas"]["Timestamp"];
            returnedAt?: components["schemas"]["Timestamp"];
            /** @description True when an item of the order had already sold; the user must cancel one sale (`doubleSales`). */
            isDoubleSale: boolean;
            /** @description One per item of the order that this sale started a delist for; none for an item that had already sold. */
            delistRuns: components["schemas"]["DelistRun"][];
            /** @description One per item of the order that had already sold. */
            doubleSales: components["schemas"]["DoubleSale"][];
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
        };
        SalePage: {
            data: components["schemas"]["Sale"][];
            /** @description Present when there are more results. */
            nextCursor?: string;
        };
        /**
         * @description A `KnownProfitGranularity`, or a bucket size added after this client was built. Clients
         *     label an unknown granularity's buckets by their `start` date.
         */
        ProfitGranularity: components["schemas"]["KnownProfitGranularity"];
        /**
         * @description The size of each `series` bucket, chosen by the server from the period's length: `day` up
         *     to 31 days, `week` (Monday to Sunday) up to 184 days, `month` beyond.
         * @enum {string}
         */
        KnownProfitGranularity: "day" | "week" | "month";
        /** @description The period the report covers, in the seller's time zone. */
        ProfitPeriod: {
            /**
             * Format: date
             * @description The period's first day.
             */
            from: string;
            /**
             * Format: date
             * @description The period's last day (inclusive).
             */
            to: string;
            /** @description The IANA time zone the days are counted in, for example `America/New_York`. */
            timeZone: string;
            granularity: components["schemas"]["ProfitGranularity"];
        };
        /**
         * @description The period's totals over its sales that stand (detected, confirmed, or shipped; a canceled
         *     or returned sale counts nowhere). `netProfit` is `revenue` minus `fees`, `shipping`, and
         *     `costOfGoods`, so the lines always add up. An item sold without a cost counts as zero cost
         *     (`missingCostCount` says how many, and the profit is overstated by their cost).
         */
        ProfitSummary: {
            /** @description What buyers paid: the sale prices plus the shipping they paid. */
            revenue: components["schemas"]["Money"];
            /** @description Every fee line except shipping labels (marketplace, payment, promotion, tax, other). */
            fees: components["schemas"]["Money"];
            /**
             * @description What the seller paid to ship: labels the marketplace deducted (`shipping_label` fee
             *     lines) plus labels bought outside the payout (`Sale.shippingCost`).
             */
            shipping: components["schemas"]["Money"];
            /** @description The sold items' costs (an item without a cost adds nothing). */
            costOfGoods: components["schemas"]["Money"];
            netProfit: components["schemas"]["Money"];
            /**
             * Format: int64
             * @description `netProfit` over `costOfGoods` in basis points (12550 is 125.5%). Absent for a zero cost of goods.
             */
            roiBasisPoints?: number;
            /**
             * Format: int32
             * @description Orders (a bundle is one).
             */
            salesCount: number;
            /** Format: int32 */
            itemsSold: number;
            /**
             * Format: int32
             * @description Sold items with no cost entered; their cost counts as zero.
             */
            missingCostCount: number;
            /** @description The sale prices over `itemsSold`. Absent when nothing sold. */
            averageSalePrice?: components["schemas"]["Money"];
            /** @description `netProfit` over `itemsSold`. Absent when nothing sold. */
            averageProfitPerItem?: components["schemas"]["Money"];
            /**
             * Format: int32
             * @description Whole days from an item's first listing (or, never listed through Listora, from when it
             *     was added) to its sale, averaged over the items sold. Absent when nothing sold.
             */
            averageDaysToSell?: number;
            /**
             * Format: int32
             * @description `itemsSold` over `itemsSold` plus the items listed now that were added by the period's
             *     end, in basis points. Absent when both are zero.
             */
            sellThroughBasisPoints?: number;
            /** @description True while any of the period's fee lines is an estimate; the profit is then an estimate too. */
            feesEstimated: boolean;
        };
        /** @description One bucket of the period's series (see `ProfitPeriod.granularity`). */
        ProfitBucket: {
            /**
             * Format: date
             * @description The bucket's first day (the period's first day for a partial first bucket).
             */
            start: string;
            revenue: components["schemas"]["Money"];
            netProfit: components["schemas"]["Money"];
            /** Format: int32 */
            itemsSold: number;
        };
        /**
         * @description The seller's own totals on one marketplace. Only totals: no ranking, share, or speed, so
         *     no marketplace's performance is presented relative to another's (eBay's API License
         *     Agreement restricts that without eBay's consent).
         */
        MarketplaceProfit: {
            marketplace: components["schemas"]["Marketplace"];
            /** Format: int32 */
            salesCount: number;
            /** Format: int32 */
            itemsSold: number;
            revenue: components["schemas"]["Money"];
            fees: components["schemas"]["Money"];
            shipping: components["schemas"]["Money"];
            costOfGoods: components["schemas"]["Money"];
            netProfit: components["schemas"]["Money"];
        };
        /** @description The period's sold items of one brand or one category. */
        ProfitGroup: {
            /** @description The brand as entered, or the category path (`ItemDetails.category`). */
            key: string;
            /** Format: int32 */
            itemsSold: number;
            revenue: components["schemas"]["Money"];
            netProfit: components["schemas"]["Money"];
            /**
             * Format: int64
             * @description `netProfit` over the items' cost in basis points. Absent for a zero cost.
             */
            roiBasisPoints?: number;
            /** Format: int32 */
            averageDaysToSell?: number;
        };
        /**
         * @description Groups ranked by net profit: up to five `best` (highest first) and up to five `worst`
         *     (lowest first), never the same group in both. Items without a brand or category are left
         *     out.
         */
        ProfitRanking: {
            best: components["schemas"]["ProfitGroup"][];
            worst: components["schemas"]["ProfitGroup"][];
        };
        /** @description Unsold items in inventory longer than the bucket's age, and the money tied up in them. */
        DeadStockBucket: {
            /** Format: int32 */
            itemCount: number;
            /** @description The items' total cost (an item without a cost adds nothing). */
            cost: components["schemas"]["Money"];
            /** Format: int32 */
            missingCostCount: number;
        };
        DeadStockItem: {
            itemId: components["schemas"]["Id"];
            sku: components["schemas"]["Sku"];
            title?: string;
            /**
             * Format: int32
             * @description Whole days since the item was bought (its purchase date) or, without one, added.
             */
            ageDays: number;
            cost?: components["schemas"]["Money"];
            status: components["schemas"]["ItemStatus"];
        };
        /**
         * @description Active inventory (draft, ready, or listed) that has not sold, by age today, whatever the
         *     report's period.
         */
        DeadStock: {
            over60Days: components["schemas"]["DeadStockBucket"];
            over90Days: components["schemas"]["DeadStockBucket"];
            /** @description The oldest items over 60 days, oldest first. */
            oldest: components["schemas"]["DeadStockItem"][];
        };
        ProfitReport: {
            period: components["schemas"]["ProfitPeriod"];
            summary: components["schemas"]["ProfitSummary"];
            /** @description One bucket per day, week, or month of the period, in order, including empty ones. */
            series: components["schemas"]["ProfitBucket"][];
            /** @description The marketplaces with a sale in the period, in the fixed `KnownMarketplace` order (never ranked). */
            marketplaces: components["schemas"]["MarketplaceProfit"][];
            brands: components["schemas"]["ProfitRanking"];
            categories: components["schemas"]["ProfitRanking"];
            deadStock: components["schemas"]["DeadStock"];
        };
        /**
         * @description A `KnownUserTaskKind`, or a kind added after this client was built. Clients show an
         *     unknown task's `title`, `instructions`, and `deepLink`, and ask the user to update
         *     the app to complete it.
         */
        UserTaskKind: components["schemas"]["KnownUserTaskKind"];
        /**
         * @description `resolve_double_sale`: an item sold twice; the user cancels one of the orders (the
         *     task's sale is the later one) and completes the task.
         * @enum {string}
         */
        KnownUserTaskKind: "list_manually" | "delist_manually" | "edit_manually" | "confirm_sale" | "reconnect" | "review_match" | "resolve_double_sale";
        /** @enum {string} */
        UserTaskStatus: "open" | "completed" | "dismissed";
        /**
         * @description `urgent` for delists after a sale (pushed, and re-alerted until done).
         * @enum {string}
         */
        UserTaskUrgency: "normal" | "urgent";
        /** @description One value the user copies into the marketplace app with one tap. */
        CopyField: {
            label: string;
            value: string;
        };
        /** @description Everything the user needs to do the task by hand. */
        CopyAssist: {
            fields: components["schemas"]["CopyField"][];
            /** @description Photos to save to the camera roll, in posting order. */
            photos: components["schemas"]["Photo"][];
        };
        UserTask: {
            id: components["schemas"]["Id"];
            kind: components["schemas"]["UserTaskKind"];
            status: components["schemas"]["UserTaskStatus"];
            urgency: components["schemas"]["UserTaskUrgency"];
            /** @description For example "Sold on Depop - delist on Poshmark". */
            title: string;
            instructions?: string;
            marketplace?: components["schemas"]["Marketplace"];
            itemId?: components["schemas"]["Id"];
            item?: components["schemas"]["UserTaskItem"];
            listingId?: components["schemas"]["Id"];
            operationId?: components["schemas"]["Id"];
            /**
             * @description For a completed `confirm_sale` or `review_match` of a sale email, the sale it recorded;
             *     for `resolve_double_sale`, the later sale.
             */
            saleId?: components["schemas"]["Id"];
            saleEmail?: components["schemas"]["UserTaskSaleEmail"];
            /**
             * Format: uri
             * @description Opens the right screen in the marketplace app or site.
             */
            deepLink?: string;
            copyAssist?: components["schemas"]["CopyAssist"];
            dueAt?: components["schemas"]["Timestamp"];
            createdAt: components["schemas"]["Timestamp"];
            completedAt?: components["schemas"]["Timestamp"];
        };
        /** @description The item a task is about, enough to show it in the task inbox. */
        UserTaskItem: {
            id: components["schemas"]["Id"];
            sku: components["schemas"]["Sku"];
            title?: string;
            coverPhoto?: components["schemas"]["Photo"];
        };
        /** @description A `KnownUserTaskSaleEmailReason`, or one added after this client was built. */
        UserTaskSaleEmailReason: components["schemas"]["KnownUserTaskSaleEmailReason"];
        /**
         * @description Why a sale email waits for the user:
         *
         *     - `ask_before_delist`: it matched `item`, and the user asked to confirm sale emails first
         *       (a `confirm_sale` task). Completing it records the sale and delists the item everywhere
         *       else; dismissing it records nothing.
         *     - `ambiguous_match`: it could be any of `candidates` (a `review_match` task).
         *     - `unknown_format`: Listora cannot read it (a `review_match` task, no `candidates`).
         * @enum {string}
         */
        KnownUserTaskSaleEmailReason: "ask_before_delist" | "ambiguous_match" | "unknown_format";
        /**
         * @description What a forwarded sale email said, for a `confirm_sale` or `review_match` task: its parsed
         *     details and a short excerpt with the buyer's details removed (Listora keeps nothing more of
         *     the email).
         */
        UserTaskSaleEmail: {
            reason: components["schemas"]["UserTaskSaleEmailReason"];
            receivedAt: components["schemas"]["Timestamp"];
            excerpt: string;
            /** @description The item's title as the email gave it. */
            title?: string;
            salePrice?: components["schemas"]["Money"];
            soldAt?: components["schemas"]["Timestamp"];
            orderNumber?: string;
            /** @description The items an ambiguous email could be; the user picks one with `matchedItemId`. */
            candidates: components["schemas"]["UserTaskItem"][];
        };
        /**
         * @description The user's confirmation and, for some kinds, their decision. Which properties apply
         *     depends on the task's `kind`; a property that does not apply is
         *     `422 validation_failed`.
         *
         *     - `list_manually`: optional `externalUrl`, the new listing's URL on the task's
         *       marketplace (links the listing, so later tasks open it); `422 validation_failed` when
         *       it is not a listing on that marketplace, and `409 already_exists` when another listing
         *       already has it.
         *     - `review_match`: the user's choice, `matchedItemId` and/or `matchedListingId`, or
         *       `rejectMatch: true` when nothing matches. Exactly one of the two is required. For a sale
         *       email, the chosen item's sale is recorded and delisted everywhere else; `422` when the
         *       email shows no price and the item has no listing price on that marketplace.
         *     - `confirm_sale`: optional `saleCorrection` when the detected details are wrong. For a sale
         *       email, completing it records the sale and delists the item everywhere else.
         *     - `delist_manually`, `edit_manually`, `reconnect`, `resolve_double_sale`: nothing besides
         *       `note`.
         *     - Every kind: optional `note`.
         */
        UserTaskCompletion: {
            /** Format: uri */
            externalUrl?: string;
            matchedItemId?: components["schemas"]["Id"];
            matchedListingId?: components["schemas"]["Id"];
            rejectMatch?: boolean;
            saleCorrection?: components["schemas"]["SaleCorrection"];
            note?: string;
        };
        /** @description Corrected sale details; a property that is absent keeps the detected value. */
        SaleCorrection: {
            /** @description The order's sale price; for a bundle it is split across the items in proportion. */
            salePrice?: components["schemas"]["Money"];
            soldAt?: components["schemas"]["Timestamp"];
            externalOrderId?: string;
        };
        UserTaskPage: {
            data: components["schemas"]["UserTask"][];
            /** @description Present when there are more results. */
            nextCursor?: string;
        };
        /**
         * @description A `KnownSaleEmailStatus`, or a status added after this client was built. Clients show
         *     `statusDisplay` as given.
         */
        SaleEmailStatus: components["schemas"]["KnownSaleEmailStatus"];
        /**
         * @description - `unavailable`: this Listora receives no email yet (no `address`).
         *     - `not_set_up`: no email has reached the address yet.
         *     - `confirming`: the email provider sent its forwarding confirmation (`confirmation`); the
         *       user confirms it in their provider's settings.
         *     - `working`: a marketplace email passed Listora's sender checks, so forwarding works.
         * @enum {string}
         */
        KnownSaleEmailStatus: "unavailable" | "not_set_up" | "confirming" | "working";
        /**
         * @description The email provider's forwarding confirmation, sent to the Listora address: the user types
         *     the `code` into their provider's settings, or opens `url` (always on the provider's own
         *     domain, from a message whose sender checks passed). Listora never opens the link itself.
         */
        SaleEmailConfirmation: {
            /** @description For example "Gmail". */
            provider: string;
            code?: string;
            /** Format: uri */
            url?: string;
            receivedAt: components["schemas"]["Timestamp"];
        };
        /**
         * @description Email sale detection: the account's private forwarding address, how to forward the
         *     marketplaces' sold emails to it, what has arrived, and the "ask before auto-delist"
         *     setting. A sold email from Poshmark, Mercari, or Depop that passes Listora's sender checks
         *     (SPF and the marketplace's DKIM signature) records the sale and delists the item everywhere
         *     else within minutes, or with `askBeforeDelist` makes a confirm task first.
         */
        SaleEmails: {
            /** @description The account's own forwarding address; absent while `status` is `unavailable`. */
            address?: string;
            status: components["schemas"]["SaleEmailStatus"];
            statusDisplay: components["schemas"]["StatusDisplay"];
            /**
             * @description When true, a sale email makes a `confirm_sale` task instead of recording the sale and
             *     delisting at once. False by default.
             */
            askBeforeDelist: boolean;
            /** @description How to set forwarding up, in order, worded for the user. */
            steps: string[];
            /** @description The email search that finds the marketplaces' sold emails, for the forwarding filter. */
            filter: string;
            /** @description Present while the provider's confirmation waits for the user (`confirming`). */
            confirmation?: components["schemas"]["SaleEmailConfirmation"];
            lastSaleEmailAt?: components["schemas"]["Timestamp"];
            lastEmailAt?: components["schemas"]["Timestamp"];
        };
        SaleEmailSettingsReplace: {
            askBeforeDelist: boolean;
        };
        /**
         * @description A `KnownTodayCardKind`, or a card added after this client was built. Clients show an
         *     unknown card's `title`, `detail`, and action generically.
         */
        TodayCardKind: components["schemas"]["KnownTodayCardKind"];
        /**
         * @description `delist`: an item sold and is not delisted (or confirmed) everywhere else yet.
         *     `ship`: a sold item that is not shipped. `reconnect`: a marketplace connection only the
         *     seller can fix (`reauth_required` or `revoked`). `review_drafts`: items still in `draft`.
         *     `stale_listing`: a listing live a long time with no changes, with a price drop (never below
         *     the item's floor) or a relist suggested.
         * @enum {string}
         */
        KnownTodayCardKind: "delist" | "ship" | "reconnect" | "review_drafts" | "stale_listing";
        /**
         * @description A `KnownTodayUrgency`, or a level added after this client was built, which clients show
         *     like `normal`.
         */
        TodayUrgency: components["schemas"]["KnownTodayUrgency"];
        /**
         * @description `urgent`: needs the seller now (a delist that is stuck or waiting for them, a ship-by date
         *     within a day or past). `high`: soon. `normal`: when the seller has a moment.
         * @enum {string}
         */
        KnownTodayUrgency: "urgent" | "high" | "normal";
        /**
         * @description A `KnownTodayDestination`, or a screen added after this client was built. Clients that do
         *     not know it open the item when the action names one, and otherwise offer no action.
         */
        TodayDestination: components["schemas"]["KnownTodayDestination"];
        /**
         * @description `item`: the item screen (`itemId`). `sale`: the sale's screen (`saleId`; `itemId` names the
         *     item too). `marketplaces`: the marketplace connections screen (`connectionId` names the
         *     connection). `drafts`: the drafts waiting for review.
         * @enum {string}
         */
        KnownTodayDestination: "item" | "sale" | "marketplaces" | "drafts";
        /** @description The card's one primary action and the screen it opens. */
        TodayAction: {
            /** @description The button's title, for example `Open sale` or `Lower to $40`. */
            label: string;
            destination: components["schemas"]["TodayDestination"];
            itemId?: components["schemas"]["Id"];
            saleId?: components["schemas"]["Id"];
            connectionId?: components["schemas"]["Id"];
        };
        /** @description The item a card is about. */
        TodayItem: {
            id: components["schemas"]["Id"];
            sku: components["schemas"]["Sku"];
            title?: string;
            /**
             * Format: uri
             * @description The item's cover photo, small; absent until a photo is processed.
             */
            thumbnailUrl?: string;
        };
        /** @description A `ship` card's sale and where the item is kept. */
        TodayShipment: {
            saleId: components["schemas"]["Id"];
            marketplace: components["schemas"]["Marketplace"];
            soldAt: components["schemas"]["Timestamp"];
            /** @description The marketplace's ship-by date, when it gives one. */
            shipBy?: components["schemas"]["Timestamp"];
            location?: components["schemas"]["TodayLocation"];
        };
        /** @description Where the item is kept, for example bin `B-12`. */
        TodayLocation: {
            code: string;
            label?: string;
        };
        /** @description A `delist` card's delist run, with its honest summary. */
        TodayDelist: {
            saleId: components["schemas"]["Id"];
            delistRunId: components["schemas"]["Id"];
            soldOn: components["schemas"]["Marketplace"];
            statusDisplay: components["schemas"]["StatusDisplay"];
            /** @description The marketplaces where it is not delisted or confirmed yet. */
            remaining: components["schemas"]["Marketplace"][];
        };
        /** @description A `reconnect` card's connection. */
        TodayConnection: {
            connectionId: components["schemas"]["Id"];
            marketplace: components["schemas"]["Marketplace"];
            displayName?: string;
            status: components["schemas"]["ConnectionStatus"];
        };
        /**
         * @description A `KnownTodayStaleSuggestion`, or a suggestion added after this client was built, which
         *     clients show through the card's `detail` and action.
         */
        TodayStaleSuggestion: components["schemas"]["KnownTodayStaleSuggestion"];
        /**
         * @description `price_drop`: lower the price to `suggestedPrice`, which is never below the item's floor.
         *     `relist`: no price drop is possible (the price is at its floor, or no floor is known).
         * @enum {string}
         */
        KnownTodayStaleSuggestion: "price_drop" | "relist";
        /** @description A `stale_listing` card's listing facts and suggestion. */
        TodayStaleListing: {
            /** @description When its oldest live listing went live. */
            listedAt: components["schemas"]["Timestamp"];
            /** Format: int32 */
            daysListed: number;
            price: components["schemas"]["Money"];
            floor?: components["schemas"]["Money"];
            suggestion: components["schemas"]["TodayStaleSuggestion"];
            /** @description Present with `price_drop`. */
            suggestedPrice?: components["schemas"]["Money"];
            /** @description Where it is live. */
            marketplaces: components["schemas"]["Marketplace"][];
        };
        /** @description A `review_drafts` card's drafts. */
        TodayDrafts: {
            /** Format: int32 */
            count: number;
            oldestCreatedAt: components["schemas"]["Timestamp"];
        };
        /**
         * @description One thing that needs the seller. A card exists only while its work is not done, so it is
         *     gone from the next summary once the work is finished. The kind's own property (`shipment`,
         *     `delist`, `connection`, `staleListing`, or `drafts`) carries its facts.
         */
        TodayCard: {
            /** @description Stable while the card's work is the same, for example `ship:<saleItemId>`. */
            id: string;
            kind: components["schemas"]["TodayCardKind"];
            urgency: components["schemas"]["TodayUrgency"];
            title: string;
            detail?: string;
            action: components["schemas"]["TodayAction"];
            item?: components["schemas"]["TodayItem"];
            shipment?: components["schemas"]["TodayShipment"];
            delist?: components["schemas"]["TodayDelist"];
            connection?: components["schemas"]["TodayConnection"];
            staleListing?: components["schemas"]["TodayStaleListing"];
            drafts?: components["schemas"]["TodayDrafts"];
        };
        /**
         * @description Sales in a 7-day period. Canceled and returned sales count for nothing. `profit` is the sum
         *     over the sales whose profit is known (price plus shipping charged, minus fees and the items'
         *     costs); a sale without recorded fees or with an item without a cost is counted in
         *     `profitPendingSales` instead. `profit` is absent when no sale's profit is known.
         */
        TodayMoneyPeriod: {
            start: components["schemas"]["Timestamp"];
            end: components["schemas"]["Timestamp"];
            /**
             * Format: int32
             * @description Orders.
             */
            sales: number;
            /** Format: int32 */
            itemsSold: number;
            /** @description What the items sold for, before shipping, fees, and costs. */
            salesTotal: components["schemas"]["Money"];
            profit?: components["schemas"]["Money"];
            /** Format: int32 */
            profitPendingSales: number;
        };
        /** @description The last 7 days (`thisWeek`, ending now) next to the 7 days before (`lastWeek`). */
        TodayMoney: {
            thisWeek: components["schemas"]["TodayMoneyPeriod"];
            lastWeek: components["schemas"]["TodayMoneyPeriod"];
        };
        Today: {
            generatedAt: components["schemas"]["Timestamp"];
            /** @description Most urgent first. Empty when the seller is all caught up. */
            cards: components["schemas"]["TodayCard"][];
            money: components["schemas"]["TodayMoney"];
        };
        /**
         * @description The morning summary notification: once a day at `time` in `timeZone`, a push that sums up
         *     the Today screen (nothing is sent on a day with nothing to do). Until the app saves a time
         *     zone, `timeZone` is absent and no summary is sent.
         */
        TodaySummarySettings: {
            enabled: boolean;
            /** @description Wall-clock `HH:MM`, 24-hour. */
            time: string;
            /** @description An IANA time zone name, for example `America/New_York`. */
            timeZone?: string;
        };
        TodaySummarySettingsReplace: {
            enabled: boolean;
            /** @description Wall-clock `HH:MM`, 24-hour. */
            time: string;
            /** @description An IANA time zone name, for example `America/New_York` (the device's own). */
            timeZone: string;
        };
    };
    responses: {
        /** @description Any error. See `KnownErrorCode` for the codes and their HTTP statuses. */
        DefaultError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Malformed request, for example an invalid cursor (`invalid_request`). */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description The resource does not exist in this account (`not_found`). */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /**
         * @description The request conflicts with the current state, for example `version_conflict`,
         *     `invalid_state_transition`, `already_exists`, or a marketplace that is not connected.
         */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description The body is well-formed but invalid (`validation_failed`, with `fieldErrors`). */
        ValidationFailed: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description A declared file is larger than allowed (`payload_too_large`). */
        PayloadTooLarge: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description The plan's quota for this action is used up (`quota_exceeded`). */
        QuotaExceeded: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Too many requests or the daily AI budget is reached; see `retryAfterSeconds`. */
        RateLimited: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description A service the request needs is switched off or down (`service_unavailable`). */
        ServiceUnavailable: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description The operation was queued. Watch `operation.status` or the listing's `statusDisplay`. */
        ListingOperationAccepted: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ListingOperationAccepted"];
            };
        };
    };
    parameters: {
        /**
         * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
         *     every retry of that action. The server stores the first successful response for at
         *     least 24 hours: a retry with the same key and body gets that response again without
         *     repeating the action; the same key with a different body gets
         *     `422 idempotency_key_reused`; a retry while the first request is still running gets
         *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
         *     stored, so retrying it with the same key runs it again.
         */
        IdempotencyKey: string;
        /** @description Opaque cursor from a previous page's `nextCursor`. Omit for the first page. */
        Cursor: string;
        /** @description Page size. */
        Limit: number;
        ItemId: components["schemas"]["Id"];
        PhotoId: components["schemas"]["Id"];
        SessionId: components["schemas"]["Id"];
        BatchId: components["schemas"]["Id"];
        AnalysisId: components["schemas"]["Id"];
        ListingId: components["schemas"]["Id"];
        OperationId: components["schemas"]["Id"];
        AuthorizationId: components["schemas"]["Id"];
        SaleId: components["schemas"]["Id"];
        TaskId: components["schemas"]["Id"];
        MarketplacePath: components["schemas"]["KnownMarketplace"];
        /** @description The app installation's id, which it keeps in its Keychain. */
        InstallationId: components["schemas"]["Id"];
        RunId: components["schemas"]["Id"];
        /** @description The call's place in its run, from 0 (path parameters are text). */
        CallIndex: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type Id = components['schemas']['Id'];
export type Timestamp = components['schemas']['Timestamp'];
export type Sku = components['schemas']['Sku'];
export type CurrencyCode = components['schemas']['CurrencyCode'];
export type Money = components['schemas']['Money'];
export type Marketplace = components['schemas']['Marketplace'];
export type KnownMarketplace = components['schemas']['KnownMarketplace'];
export type IntegrationMode = components['schemas']['IntegrationMode'];
export type KnownIntegrationMode = components['schemas']['KnownIntegrationMode'];
export type StatusTone = components['schemas']['StatusTone'];
export type KnownStatusTone = components['schemas']['KnownStatusTone'];
export type StatusDisplay = components['schemas']['StatusDisplay'];
export type VerificationMethod = components['schemas']['VerificationMethod'];
export type Verification = components['schemas']['Verification'];
export type Provenance = components['schemas']['Provenance'];
export type KnownProvenance = components['schemas']['KnownProvenance'];
export type ErrorResponse = components['schemas']['ErrorResponse'];
export type ApiError = components['schemas']['ApiError'];
export type FieldError = components['schemas']['FieldError'];
export type ErrorCode = components['schemas']['ErrorCode'];
export type KnownErrorCode = components['schemas']['KnownErrorCode'];
export type AccountDeletion = components['schemas']['AccountDeletion'];
export type MarketplaceAccessRevocation = components['schemas']['MarketplaceAccessRevocation'];
export type HealthCheckStatus = components['schemas']['HealthCheckStatus'];
export type HealthLive = components['schemas']['HealthLive'];
export type HealthReady = components['schemas']['HealthReady'];
export type ItemStatus = components['schemas']['ItemStatus'];
export type KnownItemStatus = components['schemas']['KnownItemStatus'];
export type UserSettableItemStatus = components['schemas']['UserSettableItemStatus'];
export type ItemCondition = components['schemas']['ItemCondition'];
export type MeasurementUnit = components['schemas']['MeasurementUnit'];
export type Measurement = components['schemas']['Measurement'];
export type ItemDetails = components['schemas']['ItemDetails'];
export type ItemCreate = components['schemas']['ItemCreate'];
export type ItemReplace = components['schemas']['ItemReplace'];
export type Item = components['schemas']['Item'];
export type StorageLocationSummary = components['schemas']['StorageLocationSummary'];
export type ItemRelistPrompt = components['schemas']['ItemRelistPrompt'];
export type ItemSaleSummary = components['schemas']['ItemSaleSummary'];
export type ItemSummary = components['schemas']['ItemSummary'];
export type ItemPage = components['schemas']['ItemPage'];
export type PhotoRole = components['schemas']['PhotoRole'];
export type PhotoStatus = components['schemas']['PhotoStatus'];
export type ImageContentType = components['schemas']['ImageContentType'];
export type OcrLine = components['schemas']['OcrLine'];
export type Barcode = components['schemas']['Barcode'];
export type PhotoUrls = components['schemas']['PhotoUrls'];
export type Photo = components['schemas']['Photo'];
export type PhotoList = components['schemas']['PhotoList'];
export type PhotoCreate = components['schemas']['PhotoCreate'];
export type PhotoUpdate = components['schemas']['PhotoUpdate'];
export type PhotoOrder = components['schemas']['PhotoOrder'];
export type Sha256 = components['schemas']['Sha256'];
export type UploadFileCreate = components['schemas']['UploadFileCreate'];
export type UploadSessionCreate = components['schemas']['UploadSessionCreate'];
export type UploadFileStatus = components['schemas']['UploadFileStatus'];
export type HttpHeader = components['schemas']['HttpHeader'];
export type UploadTarget = components['schemas']['UploadTarget'];
export type UploadFile = components['schemas']['UploadFile'];
export type UploadSession = components['schemas']['UploadSession'];
export type AnalysisTier = components['schemas']['AnalysisTier'];
export type AnalysisStatus = components['schemas']['AnalysisStatus'];
export type AnalysisProvenance = components['schemas']['AnalysisProvenance'];
export type KnownAnalysisProvenance = components['schemas']['KnownAnalysisProvenance'];
export type Confidence = components['schemas']['Confidence'];
export type AnalyzedText = components['schemas']['AnalyzedText'];
export type AnalyzedTextList = components['schemas']['AnalyzedTextList'];
export type AnalyzedCondition = components['schemas']['AnalyzedCondition'];
export type AnalyzedDetails = components['schemas']['AnalyzedDetails'];
export type VariantSuggestion = components['schemas']['VariantSuggestion'];
export type AnalysisResult = components['schemas']['AnalysisResult'];
export type AnalysisFailure = components['schemas']['AnalysisFailure'];
export type Analysis = components['schemas']['Analysis'];
export type AnalysisApply = components['schemas']['AnalysisApply'];
export type ItemBatchItemState = components['schemas']['ItemBatchItemState'];
export type KnownItemBatchItemState = components['schemas']['KnownItemBatchItemState'];
export type ItemBatchItemProblem = components['schemas']['ItemBatchItemProblem'];
export type InteractionTotals = components['schemas']['InteractionTotals'];
export type ItemBatchPhotoProgress = components['schemas']['ItemBatchPhotoProgress'];
export type ItemBatchItem = components['schemas']['ItemBatchItem'];
export type ItemBatchProgress = components['schemas']['ItemBatchProgress'];
export type ItemBatch = components['schemas']['ItemBatch'];
export type ItemBatchItemCreate = components['schemas']['ItemBatchItemCreate'];
export type ItemBatchItemSubmit = components['schemas']['ItemBatchItemSubmit'];
export type ItemBatchItemInteraction = components['schemas']['ItemBatchItemInteraction'];
export type ItemBatchInteractionReplace = components['schemas']['ItemBatchInteractionReplace'];
export type AiPriceEstimate = components['schemas']['AiPriceEstimate'];
export type SoldDataSource = components['schemas']['SoldDataSource'];
export type KnownSoldDataSource = components['schemas']['KnownSoldDataSource'];
export type SoldComparables = components['schemas']['SoldComparables'];
export type PriceTierName = components['schemas']['PriceTierName'];
export type PriceBasis = components['schemas']['PriceBasis'];
export type KnownPriceBasis = components['schemas']['KnownPriceBasis'];
export type PriceTier = components['schemas']['PriceTier'];
export type FloorBreakdown = components['schemas']['FloorBreakdown'];
export type MarketplaceFloor = components['schemas']['MarketplaceFloor'];
export type FeeEstimateSource = components['schemas']['FeeEstimateSource'];
export type KnownFeeEstimateSource = components['schemas']['KnownFeeEstimateSource'];
export type ResearchLink = components['schemas']['ResearchLink'];
export type PricingSuggestion = components['schemas']['PricingSuggestion'];
export type UsageMetric = components['schemas']['UsageMetric'];
export type KnownUsageMetric = components['schemas']['KnownUsageMetric'];
export type QuotaUsage = components['schemas']['QuotaUsage'];
export type Usage = components['schemas']['Usage'];
export type VoiceCorrectionRequest = components['schemas']['VoiceCorrectionRequest'];
export type VoiceCorrection = components['schemas']['VoiceCorrection'];
export type VoiceCorrectionChange = components['schemas']['VoiceCorrectionChange'];
export type VoiceCorrectionField = components['schemas']['VoiceCorrectionField'];
export type KnownVoiceCorrectionField = components['schemas']['KnownVoiceCorrectionField'];
export type ListingStatus = components['schemas']['ListingStatus'];
export type KnownListingStatus = components['schemas']['KnownListingStatus'];
export type ListingAction = components['schemas']['ListingAction'];
export type KnownListingAction = components['schemas']['KnownListingAction'];
export type ListingActionAvailability = components['schemas']['ListingActionAvailability'];
export type ListingAspect = components['schemas']['ListingAspect'];
export type ListingVariant = components['schemas']['ListingVariant'];
export type ListingCreate = components['schemas']['ListingCreate'];
export type SharedListingUrl = components['schemas']['SharedListingUrl'];
export type ListingLinkCreate = components['schemas']['ListingLinkCreate'];
export type SharedListingImport = components['schemas']['SharedListingImport'];
export type SharedListingImportResult = components['schemas']['SharedListingImportResult'];
export type ListingVariantReplace = components['schemas']['ListingVariantReplace'];
export type ListingPriceChange = components['schemas']['ListingPriceChange'];
export type ListingEndReason = components['schemas']['ListingEndReason'];
export type ListingEnd = components['schemas']['ListingEnd'];
export type Listing = components['schemas']['Listing'];
export type ListingStatusSummary = components['schemas']['ListingStatusSummary'];
export type ListingList = components['schemas']['ListingList'];
export type ListingPage = components['schemas']['ListingPage'];
export type ListingOperationAccepted = components['schemas']['ListingOperationAccepted'];
export type OperationKind = components['schemas']['OperationKind'];
export type KnownOperationKind = components['schemas']['KnownOperationKind'];
export type OperationStatus = components['schemas']['OperationStatus'];
export type KnownOperationStatus = components['schemas']['KnownOperationStatus'];
export type OperationOriginType = components['schemas']['OperationOriginType'];
export type KnownOperationOriginType = components['schemas']['KnownOperationOriginType'];
export type OperationOrigin = components['schemas']['OperationOrigin'];
export type OperationError = components['schemas']['OperationError'];
export type Operation = components['schemas']['Operation'];
export type OperationPage = components['schemas']['OperationPage'];
export type OperationEvent = components['schemas']['OperationEvent'];
export type OperationEventPage = components['schemas']['OperationEventPage'];
export type ConnectionStatus = components['schemas']['ConnectionStatus'];
export type KnownConnectionStatus = components['schemas']['KnownConnectionStatus'];
export type CapabilityMode = components['schemas']['CapabilityMode'];
export type KnownCapabilityMode = components['schemas']['KnownCapabilityMode'];
export type MarkSoldMode = components['schemas']['MarkSoldMode'];
export type KnownMarkSoldMode = components['schemas']['KnownMarkSoldMode'];
export type ConnectMethod = components['schemas']['ConnectMethod'];
export type KnownConnectMethod = components['schemas']['KnownConnectMethod'];
export type VerifyReadMode = components['schemas']['VerifyReadMode'];
export type KnownVerifyReadMode = components['schemas']['KnownVerifyReadMode'];
export type ImportListingsMode = components['schemas']['ImportListingsMode'];
export type KnownImportListingsMode = components['schemas']['KnownImportListingsMode'];
export type ImageTransportMode = components['schemas']['ImageTransportMode'];
export type KnownImageTransportMode = components['schemas']['KnownImageTransportMode'];
export type MarketplaceCapabilities = components['schemas']['MarketplaceCapabilities'];
export type ConnectionIssue = components['schemas']['ConnectionIssue'];
export type ConnectionAction = components['schemas']['ConnectionAction'];
export type KnownConnectionAction = components['schemas']['KnownConnectionAction'];
export type Connection = components['schemas']['Connection'];
export type ConnectionList = components['schemas']['ConnectionList'];
export type ConnectionAuthorizationStatus = components['schemas']['ConnectionAuthorizationStatus'];
export type ConnectionAuthorization = components['schemas']['ConnectionAuthorization'];
export type ConnectionAttentionReason = components['schemas']['ConnectionAttentionReason'];
export type KnownConnectionAttentionReason = components['schemas']['KnownConnectionAttentionReason'];
export type ConnectionAttention = components['schemas']['ConnectionAttention'];
export type SaleForwardingStatus = components['schemas']['SaleForwardingStatus'];
export type KnownSaleForwardingStatus = components['schemas']['KnownSaleForwardingStatus'];
export type SaleForwarding = components['schemas']['SaleForwarding'];
export type ConnectionHealthSummary = components['schemas']['ConnectionHealthSummary'];
export type MarketplaceSessionStatus = components['schemas']['MarketplaceSessionStatus'];
export type KnownMarketplaceSessionStatus = components['schemas']['KnownMarketplaceSessionStatus'];
export type MarketplaceSessionLogin = components['schemas']['MarketplaceSessionLogin'];
export type MarketplaceSession = components['schemas']['MarketplaceSession'];
export type MarketplaceSessionList = components['schemas']['MarketplaceSessionList'];
export type SessionCookie = components['schemas']['SessionCookie'];
export type MarketplaceSessionLink = components['schemas']['MarketplaceSessionLink'];
export type ExecutionLocation = components['schemas']['ExecutionLocation'];
export type KnownExecutionLocation = components['schemas']['KnownExecutionLocation'];
export type ConnectionExecution = components['schemas']['ConnectionExecution'];
export type ConnectionExecutionChange = components['schemas']['ConnectionExecutionChange'];
export type DevicePlatform = components['schemas']['DevicePlatform'];
export type PushEnvironment = components['schemas']['PushEnvironment'];
export type DeviceRegistration = components['schemas']['DeviceRegistration'];
export type Device = components['schemas']['Device'];
export type PhoneWorkPurpose = components['schemas']['PhoneWorkPurpose'];
export type KnownPhoneWorkPurpose = components['schemas']['KnownPhoneWorkPurpose'];
export type PhoneRunClaim = components['schemas']['PhoneRunClaim'];
export type PhoneCall = components['schemas']['PhoneCall'];
export type PhoneRun = components['schemas']['PhoneRun'];
export type PhoneRunResult = components['schemas']['PhoneRunResult'];
export type PhoneCallAnswer = components['schemas']['PhoneCallAnswer'];
export type SaleStatus = components['schemas']['SaleStatus'];
export type KnownSaleStatus = components['schemas']['KnownSaleStatus'];
export type SaleDetectionSource = components['schemas']['SaleDetectionSource'];
export type KnownSaleDetectionSource = components['schemas']['KnownSaleDetectionSource'];
export type DelistRunStatus = components['schemas']['DelistRunStatus'];
export type DelistResultState = components['schemas']['DelistResultState'];
export type KnownDelistResultState = components['schemas']['KnownDelistResultState'];
export type DelistResult = components['schemas']['DelistResult'];
export type DelistRun = components['schemas']['DelistRun'];
export type DoubleSale = components['schemas']['DoubleSale'];
export type SaleItem = components['schemas']['SaleItem'];
export type SaleCreateItem = components['schemas']['SaleCreateItem'];
export type SaleAction = components['schemas']['SaleAction'];
export type KnownSaleAction = components['schemas']['KnownSaleAction'];
export type RelistDecision = components['schemas']['RelistDecision'];
export type KnownRelistDecision = components['schemas']['KnownRelistDecision'];
export type RelistOption = components['schemas']['RelistOption'];
export type SaleRelist = components['schemas']['SaleRelist'];
export type SaleShipment = components['schemas']['SaleShipment'];
export type SaleRelistChoice = components['schemas']['SaleRelistChoice'];
export type SaleRelistItemChoice = components['schemas']['SaleRelistItemChoice'];
export type KnownFeeType = components['schemas']['KnownFeeType'];
export type FeeType = components['schemas']['FeeType'];
export type FeeSource = components['schemas']['FeeSource'];
export type FeeLine = components['schemas']['FeeLine'];
export type SaleCreate = components['schemas']['SaleCreate'];
export type Sale = components['schemas']['Sale'];
export type SalePage = components['schemas']['SalePage'];
export type ProfitGranularity = components['schemas']['ProfitGranularity'];
export type KnownProfitGranularity = components['schemas']['KnownProfitGranularity'];
export type ProfitPeriod = components['schemas']['ProfitPeriod'];
export type ProfitSummary = components['schemas']['ProfitSummary'];
export type ProfitBucket = components['schemas']['ProfitBucket'];
export type MarketplaceProfit = components['schemas']['MarketplaceProfit'];
export type ProfitGroup = components['schemas']['ProfitGroup'];
export type ProfitRanking = components['schemas']['ProfitRanking'];
export type DeadStockBucket = components['schemas']['DeadStockBucket'];
export type DeadStockItem = components['schemas']['DeadStockItem'];
export type DeadStock = components['schemas']['DeadStock'];
export type ProfitReport = components['schemas']['ProfitReport'];
export type UserTaskKind = components['schemas']['UserTaskKind'];
export type KnownUserTaskKind = components['schemas']['KnownUserTaskKind'];
export type UserTaskStatus = components['schemas']['UserTaskStatus'];
export type UserTaskUrgency = components['schemas']['UserTaskUrgency'];
export type CopyField = components['schemas']['CopyField'];
export type CopyAssist = components['schemas']['CopyAssist'];
export type UserTask = components['schemas']['UserTask'];
export type UserTaskItem = components['schemas']['UserTaskItem'];
export type UserTaskSaleEmailReason = components['schemas']['UserTaskSaleEmailReason'];
export type KnownUserTaskSaleEmailReason = components['schemas']['KnownUserTaskSaleEmailReason'];
export type UserTaskSaleEmail = components['schemas']['UserTaskSaleEmail'];
export type UserTaskCompletion = components['schemas']['UserTaskCompletion'];
export type SaleCorrection = components['schemas']['SaleCorrection'];
export type UserTaskPage = components['schemas']['UserTaskPage'];
export type SaleEmailStatus = components['schemas']['SaleEmailStatus'];
export type KnownSaleEmailStatus = components['schemas']['KnownSaleEmailStatus'];
export type SaleEmailConfirmation = components['schemas']['SaleEmailConfirmation'];
export type SaleEmails = components['schemas']['SaleEmails'];
export type SaleEmailSettingsReplace = components['schemas']['SaleEmailSettingsReplace'];
export type TodayCardKind = components['schemas']['TodayCardKind'];
export type KnownTodayCardKind = components['schemas']['KnownTodayCardKind'];
export type TodayUrgency = components['schemas']['TodayUrgency'];
export type KnownTodayUrgency = components['schemas']['KnownTodayUrgency'];
export type TodayDestination = components['schemas']['TodayDestination'];
export type KnownTodayDestination = components['schemas']['KnownTodayDestination'];
export type TodayAction = components['schemas']['TodayAction'];
export type TodayItem = components['schemas']['TodayItem'];
export type TodayShipment = components['schemas']['TodayShipment'];
export type TodayLocation = components['schemas']['TodayLocation'];
export type TodayDelist = components['schemas']['TodayDelist'];
export type TodayConnection = components['schemas']['TodayConnection'];
export type TodayStaleSuggestion = components['schemas']['TodayStaleSuggestion'];
export type KnownTodayStaleSuggestion = components['schemas']['KnownTodayStaleSuggestion'];
export type TodayStaleListing = components['schemas']['TodayStaleListing'];
export type TodayDrafts = components['schemas']['TodayDrafts'];
export type TodayCard = components['schemas']['TodayCard'];
export type TodayMoneyPeriod = components['schemas']['TodayMoneyPeriod'];
export type TodayMoney = components['schemas']['TodayMoney'];
export type Today = components['schemas']['Today'];
export type TodaySummarySettings = components['schemas']['TodaySummarySettings'];
export type TodaySummarySettingsReplace = components['schemas']['TodaySummarySettingsReplace'];
export type ResponseDefaultError = components['responses']['DefaultError'];
export type ResponseBadRequest = components['responses']['BadRequest'];
export type ResponseNotFound = components['responses']['NotFound'];
export type ResponseConflict = components['responses']['Conflict'];
export type ResponseValidationFailed = components['responses']['ValidationFailed'];
export type ResponsePayloadTooLarge = components['responses']['PayloadTooLarge'];
export type ResponseQuotaExceeded = components['responses']['QuotaExceeded'];
export type ResponseRateLimited = components['responses']['RateLimited'];
export type ResponseServiceUnavailable = components['responses']['ServiceUnavailable'];
export type ResponseListingOperationAccepted = components['responses']['ListingOperationAccepted'];
export type ParameterIdempotencyKey = components['parameters']['IdempotencyKey'];
export type ParameterCursor = components['parameters']['Cursor'];
export type ParameterLimit = components['parameters']['Limit'];
export type ParameterItemId = components['parameters']['ItemId'];
export type ParameterPhotoId = components['parameters']['PhotoId'];
export type ParameterSessionId = components['parameters']['SessionId'];
export type ParameterBatchId = components['parameters']['BatchId'];
export type ParameterAnalysisId = components['parameters']['AnalysisId'];
export type ParameterListingId = components['parameters']['ListingId'];
export type ParameterOperationId = components['parameters']['OperationId'];
export type ParameterAuthorizationId = components['parameters']['AuthorizationId'];
export type ParameterSaleId = components['parameters']['SaleId'];
export type ParameterTaskId = components['parameters']['TaskId'];
export type ParameterMarketplacePath = components['parameters']['MarketplacePath'];
export type ParameterInstallationId = components['parameters']['InstallationId'];
export type ParameterRunId = components['parameters']['RunId'];
export type ParameterCallIndex = components['parameters']['CallIndex'];
export type $defs = Record<string, never>;
export interface operations {
    getLiveness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The process is running. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthLive"];
                };
            };
        };
    };
    getReadiness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ready. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthReady"];
                };
            };
            /** @description Not ready; at least one check is unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthReady"];
                };
            };
        };
    };
    deleteAccount: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The account is deleted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountDeletion"];
                };
            };
            /**
             * @description The account has other members, so it cannot be deleted with this person
             *     (`forbidden`); they must leave first.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            default: components["responses"]["DefaultError"];
        };
    };
    listItems: {
        parameters: {
            query?: {
                /** @description Only items in one of these statuses. */
                status?: components["schemas"]["KnownItemStatus"][];
                /** @description Free-text search over SKU, title, brand, and keywords. */
                q?: string;
                /**
                 * @description Only items with a listing on this marketplace that is not ended or sold (a draft
                 *     listing, or one being published, counts).
                 */
                marketplace?: components["schemas"]["KnownMarketplace"];
                /** @description Only items of this brand (exact, ignoring case). */
                brand?: string;
                /** @description Opaque cursor from a previous page's `nextCursor`. Omit for the first page. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of items. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            default: components["responses"]["DefaultError"];
        };
    };
    createItem: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ItemCreate"];
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Item"];
                };
            };
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    getItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The item. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Item"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    replaceItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ItemReplace"];
            };
        };
        responses: {
            /** @description The updated item. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Item"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    deleteItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    getItemBySku: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The item's SKU, for example `AJ-000184` (from a scanned label). */
                sku: components["schemas"]["Sku"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The item that owns this SKU. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Item"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    createUploadSession: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadSessionCreate"];
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadSession"];
                };
            };
            413: components["responses"]["PayloadTooLarge"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    getUploadSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadSession"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    addItemPhoto: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PhotoCreate"];
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Photo"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    reorderItemPhotos: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PhotoOrder"];
            };
        };
        responses: {
            /** @description The photos in their new order. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PhotoList"];
                };
            };
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    deleteItemPhoto: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
                photoId: components["parameters"]["PhotoId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    updateItemPhoto: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
                photoId: components["parameters"]["PhotoId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PhotoUpdate"];
            };
        };
        responses: {
            /** @description The updated photo. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Photo"];
                };
            };
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    startItemAnalysis: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The analysis for the current photo set (new or existing). */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Analysis"];
                };
            };
            402: components["responses"]["QuotaExceeded"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            503: components["responses"]["ServiceUnavailable"];
            default: components["responses"]["DefaultError"];
        };
    };
    getAnalysis: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                analysisId: components["parameters"]["AnalysisId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The analysis. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Analysis"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    escalateAnalysis: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                analysisId: components["parameters"]["AnalysisId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The premium analysis. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Analysis"];
                };
            };
            402: components["responses"]["QuotaExceeded"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            503: components["responses"]["ServiceUnavailable"];
            default: components["responses"]["DefaultError"];
        };
    };
    applyAnalysis: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                analysisId: components["parameters"]["AnalysisId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AnalysisApply"];
            };
        };
        responses: {
            /** @description The updated item. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Item"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    createItemBatch: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemBatch"];
                };
            };
            default: components["responses"]["DefaultError"];
        };
    };
    getItemBatch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batchId: components["parameters"]["BatchId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The batch. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemBatch"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    addItemBatchItem: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                batchId: components["parameters"]["BatchId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ItemBatchItemCreate"];
            };
        };
        responses: {
            /** @description The item already at that position. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemBatchItem"];
                };
            };
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemBatchItem"];
                };
            };
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    submitItemBatchItem: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                batchId: components["parameters"]["BatchId"];
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ItemBatchItemSubmit"];
            };
        };
        responses: {
            /** @description The item, as it is now. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemBatchItem"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    replaceItemBatchInteraction: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batchId: components["parameters"]["BatchId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ItemBatchInteractionReplace"];
            };
        };
        responses: {
            /** @description The batch. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemBatch"];
                };
            };
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    getUsage: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Quota use for the current period. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Usage"];
                };
            };
            default: components["responses"]["DefaultError"];
        };
    };
    interpretVoiceCorrection: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VoiceCorrectionRequest"];
            };
        };
        responses: {
            /** @description The proposed changes, possibly none. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VoiceCorrection"];
                };
            };
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["RateLimited"];
            503: components["responses"]["ServiceUnavailable"];
            default: components["responses"]["DefaultError"];
        };
    };
    getItemPricing: {
        parameters: {
            query?: {
                /**
                 * @description What the seller expects to pay for shipping, in cents of the item's currency.
                 *     Added to every floor. Defaults to 0 (the buyer pays shipping).
                 */
                shippingCents?: number;
                /**
                 * @description The least profit the seller accepts on this item, in cents of the item's currency.
                 *     Added to every floor. Defaults to 0 (break even).
                 */
                minimumProfitCents?: number;
            };
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Price suggestions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PricingSuggestion"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    listItemListings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The item's listings. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListingList"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    createListing: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ListingCreate"];
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Listing"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    linkItemListing: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                itemId: components["parameters"]["ItemId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ListingLinkCreate"];
            };
        };
        responses: {
            /** @description Linked. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Listing"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    importSharedListing: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SharedListingImport"];
            };
        };
        responses: {
            /** @description Created and linked. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SharedListingImportResult"];
                };
            };
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    listListings: {
        parameters: {
            query?: {
                marketplace?: components["schemas"]["KnownMarketplace"];
                status?: components["schemas"]["KnownListingStatus"][];
                /** @description Opaque cursor from a previous page's `nextCursor`. Omit for the first page. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of listings. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListingPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            default: components["responses"]["DefaultError"];
        };
    };
    getListing: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The listing. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Listing"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    replaceListingDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ListingVariantReplace"];
            };
        };
        responses: {
            /** @description The updated listing. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Listing"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    publishListing: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: components["responses"]["ListingOperationAccepted"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    reviseListing: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ListingVariantReplace"];
            };
        };
        responses: {
            202: components["responses"]["ListingOperationAccepted"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    changeListingPrice: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ListingPriceChange"];
            };
        };
        responses: {
            202: components["responses"]["ListingOperationAccepted"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    endListing: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ListingEnd"];
            };
        };
        responses: {
            202: components["responses"]["ListingOperationAccepted"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    relistListing: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: components["responses"]["ListingOperationAccepted"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    verifyListing: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                listingId: components["parameters"]["ListingId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: components["responses"]["ListingOperationAccepted"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    listOperations: {
        parameters: {
            query?: {
                itemId?: components["schemas"]["Id"];
                listingId?: components["schemas"]["Id"];
                status?: components["schemas"]["KnownOperationStatus"][];
                /** @description Opaque cursor from a previous page's `nextCursor`. Omit for the first page. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of operations. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperationPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            default: components["responses"]["DefaultError"];
        };
    };
    getOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    listOperationEvents: {
        parameters: {
            query?: {
                /** @description Opaque cursor from a previous page's `nextCursor`. Omit for the first page. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of events. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperationEventPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    retryOperation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The queued operation. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    cancelOperation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The canceled operation. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    listConnections: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Every marketplace and its connection state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionList"];
                };
            };
            default: components["responses"]["DefaultError"];
        };
    };
    getConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The connection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Connection"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    disconnectConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The connection, now `not_connected`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Connection"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    startConnectionAuthorization: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionAuthorization"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    getConnectionAuthorization: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
                authorizationId: components["parameters"]["AuthorizationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The authorization attempt. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionAuthorization"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    handleConnectionCallback: {
        parameters: {
            query?: {
                /**
                 * @description The attempt's `state`. Not marked required: a marketplace's "declined" redirect may
                 *     come without it, and that still has to reach the app.
                 */
                state?: string;
                /** @description Authorization code; absent when the user declined. */
                code?: string;
                /** @description OAuth error code, for example `access_denied`. */
                error?: string;
                error_description?: string;
            };
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Redirect to the app. */
            302: {
                headers: {
                    /** @description An app URL with the `listora` scheme. */
                    Location: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
            default: components["responses"]["DefaultError"];
        };
    };
    requestConnectionCheck: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The check is queued. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Connection"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    setConnectionExecution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionExecutionChange"];
            };
        };
        responses: {
            /** @description The connection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Connection"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    getConnectionHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The summary. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionHealthSummary"];
                };
            };
            default: components["responses"]["DefaultError"];
        };
    };
    listMarketplaceSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Every marketplace linked by signing in, and its state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MarketplaceSessionList"];
                };
            };
            default: components["responses"]["DefaultError"];
        };
    };
    getMarketplaceSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The marketplace's state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MarketplaceSession"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    linkMarketplaceSession: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                marketplace: components["parameters"]["MarketplacePath"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MarketplaceSessionLink"];
            };
        };
        responses: {
            /** @description Stored; the session is being checked. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MarketplaceSession"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    listSales: {
        parameters: {
            query?: {
                /** @description Only sales whose order contains this item. */
                itemId?: components["schemas"]["Id"];
                status?: components["schemas"]["KnownSaleStatus"][];
                /**
                 * @description Only sales with a delist run in one of these statuses; for example
                 *     `in_progress` and `needs_attention` for the home screen's banner.
                 */
                delistStatus?: components["schemas"]["DelistRunStatus"][];
                /** @description Opaque cursor from a previous page's `nextCursor`. Omit for the first page. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of sales. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SalePage"];
                };
            };
            400: components["responses"]["BadRequest"];
            default: components["responses"]["DefaultError"];
        };
    };
    createSale: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SaleCreate"];
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sale"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    getSale: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The sale. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sale"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    confirmSale: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The sale, now `confirmed`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sale"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    markSaleShipped: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SaleShipment"];
            };
        };
        responses: {
            /** @description The sale, now `shipped`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sale"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    cancelSale: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The sale, now `canceled`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sale"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    recordSaleReturn: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The sale, now `returned`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sale"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    decideSaleRelist: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                saleId: components["parameters"]["SaleId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SaleRelistChoice"];
            };
        };
        responses: {
            /** @description The sale with the decisions recorded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sale"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    getProfit: {
        parameters: {
            query: {
                /** @description The period's first day in `timeZone`. */
                from: string;
                /** @description The period's last day in `timeZone` (inclusive). */
                to: string;
                /** @description The seller's IANA time zone, for example `America/New_York`. */
                timeZone: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The period's report. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProfitReport"];
                };
            };
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    listTasks: {
        parameters: {
            query?: {
                status?: components["schemas"]["UserTaskStatus"][];
                itemId?: components["schemas"]["Id"];
                /** @description Opaque cursor from a previous page's `nextCursor`. Omit for the first page. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of tasks. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserTaskPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            default: components["responses"]["DefaultError"];
        };
    };
    getTask: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                taskId: components["parameters"]["TaskId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The task. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserTask"];
                };
            };
            404: components["responses"]["NotFound"];
            default: components["responses"]["DefaultError"];
        };
    };
    completeTask: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                taskId: components["parameters"]["TaskId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserTaskCompletion"];
            };
        };
        responses: {
            /** @description The completed task. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserTask"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    dismissTask: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                taskId: components["parameters"]["TaskId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The dismissed task. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserTask"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    getSaleEmails: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The account's sale email forwarding. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SaleEmails"];
                };
            };
            default: components["responses"]["DefaultError"];
        };
    };
    replaceSaleEmailSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SaleEmailSettingsReplace"];
            };
        };
        responses: {
            /** @description The account's sale email forwarding, with the saved setting. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SaleEmails"];
                };
            };
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    getToday: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The summary as of `generatedAt`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Today"];
                };
            };
            default: components["responses"]["DefaultError"];
        };
    };
    getTodaySettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The setting. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TodaySummarySettings"];
                };
            };
            default: components["responses"]["DefaultError"];
        };
    };
    replaceTodaySettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TodaySummarySettingsReplace"];
            };
        };
        responses: {
            /** @description The saved setting. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TodaySummarySettings"];
                };
            };
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    registerDevice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The app installation's id, which it keeps in its Keychain. */
                installationId: components["parameters"]["InstallationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeviceRegistration"];
            };
        };
        responses: {
            /** @description The device. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Device"];
                };
            };
            422: components["responses"]["ValidationFailed"];
            default: components["responses"]["DefaultError"];
        };
    };
    claimPhoneRun: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description A unique client-generated key (use a UUID v4) per logical action, reused unchanged on
                 *     every retry of that action. The server stores the first successful response for at
                 *     least 24 hours: a retry with the same key and body gets that response again without
                 *     repeating the action; the same key with a different body gets
                 *     `422 idempotency_key_reused`; a retry while the first request is still running gets
                 *     `409 idempotency_key_in_progress`. A request that failed changed nothing and is not
                 *     stored, so retrying it with the same key runs it again.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PhoneRunClaim"];
            };
        };
        responses: {
            /** @description The claimed run, or none. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PhoneRunResult"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
    answerPhoneCall: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
                /** @description The call's place in its run, from 0 (path parameters are text). */
                index: components["parameters"]["CallIndex"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PhoneCallAnswer"];
            };
        };
        responses: {
            /** @description The run's next call, or none. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PhoneRunResult"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["DefaultError"];
        };
    };
}
type FlattenedDeepRequired<T> = {
    [K in keyof T]-?: FlattenedDeepRequired<T[K] extends unknown[] | undefined | null ? Extract<T[K], unknown[]>[number] : T[K]>;
};
type ReadonlyArray<T> = [
    Exclude<T, undefined>
] extends [
    unknown[]
] ? Readonly<Exclude<T, undefined>> : Readonly<Exclude<T, undefined>[]>;
export const currencyCodeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["CurrencyCode"]> = ["USD"];
export const knownMarketplaceValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownMarketplace"]> = ["ebay", "depop", "poshmark", "mercari"];
export const knownIntegrationModeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownIntegrationMode"]> = ["api", "automation", "assisted"];
export const knownStatusToneValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownStatusTone"]> = ["success", "in_progress", "checking", "failed", "action_needed", "neutral"];
export const verificationMethodValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["VerificationMethod"]> = ["marketplace_api", "user_confirmation"];
export const knownProvenanceValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownProvenance"]> = ["ai", "ocr", "barcode", "user"];
export const knownErrorCodeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownErrorCode"]> = ["invalid_request", "unauthenticated", "quota_exceeded", "forbidden", "not_found", "version_conflict", "invalid_state_transition", "already_exists", "idempotency_key_in_progress", "upload_incomplete", "upload_expired", "marketplace_not_connected", "marketplace_reauth_required", "marketplace_action_unavailable", "app_update_required", "payload_too_large", "validation_failed", "idempotency_key_reused", "rate_limited", "ai_budget_exceeded", "internal_error", "service_unavailable", "marketplace_authorization_denied", "marketplace_authorization_failed"];
export const healthCheckStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["HealthCheckStatus"]> = ["ok", "unavailable"];
export const knownItemStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownItemStatus"]> = ["draft", "ready", "listed", "sold_pending_delist", "sold", "shipped", "archived"];
export const userSettableItemStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["UserSettableItemStatus"]> = ["draft", "ready", "archived"];
export const itemConditionValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["ItemCondition"]> = ["new_with_tags", "new_without_tags", "new_with_defects", "pre_owned_excellent", "pre_owned_good", "pre_owned_fair"];
export const measurementUnitValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["MeasurementUnit"]> = ["in", "cm"];
export const photoRoleValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["PhotoRole"]> = ["front", "back", "tag", "flaw", "detail"];
export const photoStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["PhotoStatus"]> = ["processing", "ready", "failed"];
export const imageContentTypeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["ImageContentType"]> = ["image/jpeg"];
export const uploadFileStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["UploadFileStatus"]> = ["pending", "uploaded", "attached"];
export const uploadTargetMethodValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["UploadTarget"]["method"]> = ["PUT"];
export const analysisTierValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["AnalysisTier"]> = ["fast", "premium"];
export const analysisStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["AnalysisStatus"]> = ["queued", "running", "completed", "failed"];
export const knownAnalysisProvenanceValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownAnalysisProvenance"]> = ["ai", "ocr", "barcode"];
export const knownItemBatchItemStateValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownItemBatchItemState"]> = ["uploading", "preparing_photos", "analyzing", "ready_for_review", "saved", "failed"];
export const knownSoldDataSourceValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownSoldDataSource"]> = ["depop_inspiration", "ebay_mi", "own_history"];
export const priceTierNameValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["PriceTierName"]> = ["quick_sale", "recommended", "higher_profit"];
export const knownPriceBasisValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownPriceBasis"]> = ["sold_data", "ai_estimate", "cost_floor"];
export const knownFeeEstimateSourceValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownFeeEstimateSource"]> = ["fee_table", "actual_fees"];
export const knownUsageMetricValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownUsageMetric"]> = ["ai_items", "premium_identifications"];
export const knownVoiceCorrectionFieldValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownVoiceCorrectionField"]> = ["title", "brand", "productName", "category", "department", "sizeLabel", "sizeSystem", "colors", "pattern", "materials", "keywords", "styleNumber", "condition", "conditionNotes", "flaws", "cost", "purchaseSource", "listPrice"];
export const knownListingStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownListingStatus"]> = ["draft", "queued", "publishing", "active", "ending", "ended", "sold", "error", "unknown", "needs_user_action"];
export const knownListingActionValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownListingAction"]> = ["publish", "revise", "change_price", "end", "relist", "verify"];
export const listingEndReasonValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["ListingEndReason"]> = ["sold_elsewhere", "not_available", "other"];
export const knownOperationKindValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownOperationKind"]> = ["create", "revise", "price", "end", "relist", "mark_sold", "verify"];
export const knownOperationStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownOperationStatus"]> = ["queued", "running", "retrying", "verifying", "succeeded", "failed", "needs_user_action", "canceled"];
export const knownOperationOriginTypeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownOperationOriginType"]> = ["user", "auto_delist", "reprice_rule"];
export const knownConnectionStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownConnectionStatus"]> = ["not_connected", "connected", "degraded", "reauth_required", "revoked"];
export const knownCapabilityModeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownCapabilityMode"]> = ["api", "automation", "assisted", "bulk_file", "none"];
export const knownMarkSoldModeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownMarkSoldMode"]> = ["api", "automation", "assisted", "bulk_file", "none", "not_needed"];
export const knownConnectMethodValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownConnectMethod"]> = ["oauth", "session", "none"];
export const knownVerifyReadModeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownVerifyReadMode"]> = ["api", "automation", "user_confirm"];
export const knownImportListingsModeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownImportListingsMode"]> = ["api", "share_sheet", "bulk_file", "none"];
export const knownImageTransportModeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownImageTransportMode"]> = ["url_fetch", "upload", "user_saves_photos"];
export const knownConnectionActionValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownConnectionAction"]> = ["connect", "reconnect", "check"];
export const connectionAuthorizationStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["ConnectionAuthorizationStatus"]> = ["pending", "completed", "failed", "expired"];
export const knownConnectionAttentionReasonValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownConnectionAttentionReason"]> = ["reconnect", "access_removed", "connection_problem", "expiring", "not_confirmed"];
export const knownSaleForwardingStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownSaleForwardingStatus"]> = ["needs_domain", "not_set_up", "confirming", "working"];
export const knownMarketplaceSessionStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownMarketplaceSessionStatus"]> = ["not_linked", "checking", "linked", "needs_relink", "check_failed", "api_connected"];
export const sessionCookieSameSiteValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["SessionCookie"]["sameSite"]> = ["strict", "lax", "none"];
export const knownExecutionLocationValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownExecutionLocation"]> = ["cloud", "phone"];
export const devicePlatformValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["DevicePlatform"]> = ["ios"];
export const pushEnvironmentValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["PushEnvironment"]> = ["sandbox", "production"];
export const knownPhoneWorkPurposeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownPhoneWorkPurpose"]> = ["operation", "session_check", "sale_check"];
export const knownSaleStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownSaleStatus"]> = ["detected", "confirmed", "shipped", "canceled", "returned"];
export const knownSaleDetectionSourceValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownSaleDetectionSource"]> = ["webhook", "poll", "email", "manual"];
export const delistRunStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["DelistRunStatus"]> = ["in_progress", "completed", "needs_attention"];
export const knownDelistResultStateValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownDelistResultState"]> = ["pending", "verifying", "delisted", "user_confirmed", "needs_user_action", "failed", "canceled"];
export const knownSaleActionValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownSaleAction"]> = ["confirm", "mark_shipped", "cancel", "record_return"];
export const knownRelistDecisionValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownRelistDecision"]> = ["pending", "relisted", "declined"];
export const knownFeeTypeValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownFeeType"]> = ["marketplace", "payment", "shipping_label", "promotion", "tax", "other"];
export const feeSourceValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["FeeSource"]> = ["actual", "estimated"];
export const knownProfitGranularityValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownProfitGranularity"]> = ["day", "week", "month"];
export const knownUserTaskKindValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownUserTaskKind"]> = ["list_manually", "delist_manually", "edit_manually", "confirm_sale", "reconnect", "review_match", "resolve_double_sale"];
export const userTaskStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["UserTaskStatus"]> = ["open", "completed", "dismissed"];
export const userTaskUrgencyValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["UserTaskUrgency"]> = ["normal", "urgent"];
export const knownUserTaskSaleEmailReasonValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownUserTaskSaleEmailReason"]> = ["ask_before_delist", "ambiguous_match", "unknown_format"];
export const knownSaleEmailStatusValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownSaleEmailStatus"]> = ["unavailable", "not_set_up", "confirming", "working"];
export const knownTodayCardKindValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownTodayCardKind"]> = ["delist", "ship", "reconnect", "review_drafts", "stale_listing"];
export const knownTodayUrgencyValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownTodayUrgency"]> = ["urgent", "high", "normal"];
export const knownTodayDestinationValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownTodayDestination"]> = ["item", "sale", "marketplaces", "drafts"];
export const knownTodayStaleSuggestionValues: ReadonlyArray<FlattenedDeepRequired<components>["schemas"]["KnownTodayStaleSuggestion"]> = ["price_drop", "relist"];
