# Taifa Mail native clients: API contract (v1)

Scope: every endpoint the v1 native clients (macOS and Windows) use. Verified against the backend repository `taifa-mail` at `origin/main` and against the mobile client `taifa-mail-mobile/src/mailApi.ts`. Citations are `file:line` in the backend `backend/app/` tree at that commit (so `api/inbox.py:1657` is `backend/app/api/inbox.py` line 1657). Line numbers drift; the symbol names are the stable reference.

Base URL: `https://mail.govconnect.ke` (the public webmail host; the mobile client hardcodes the same value, `taifa-mail-mobile/src/apiConfig.ts`). All paths below are relative to it. Request and response bodies are JSON (`Content-Type: application/json`, `Accept: application/json`) unless noted. All dates are ISO 8601 strings unless noted.

Notation: `{id}` is the mailbox UUID from the session (`mailbox_id`). Folder names are IMAP paths (`INBOX`, `Sent`, `Drafts`, `Trash`, `Junk`, `Archive`, or custom).

## 1. Authentication model

A native client is a cookie client, exactly like a browser, and like the mobile app.

Cookies set by the server on sign in (`api/auth.py:180-219`, `_set_mailbox_cookies`):

| Cookie | Flags | Purpose |
|---|---|---|
| `tfm_mb_access` | HttpOnly, SameSite=Lax, Secure, host only, 30 day max age | mailbox access token (JWT, `type: mailbox_access`) |
| `tfm_mb_refresh` | HttpOnly, SameSite=Lax, Secure, host only, 30 day max age | refresh token (JWT, `type: mailbox_refresh`) |
| `tfm_csrf` | readable (not HttpOnly), SameSite=Lax, Secure, domain scoped, 30 day max age | CSRF double submit token |
| `tfm_mb_2fa` | host only | pending second factor, set when sign in answers `requires_2fa` (`api/auth.py:228`) |

The client keeps these in an app private cookie store (macOS: `HTTPCookieStorage` of a dedicated `URLSessionConfiguration`, persisted to the Keychain; Windows: an app private cookie container, persisted through DPAPI or Credential Locker). Cookies are never shared with a browser and are deleted on sign out.

There is no Authorization header flow for mailbox sessions in v1. Do not send `Origin` or `Referer` headers (the CSRF check only validates Origin when one is present, `core/csrf.py`, last block).

### 1.1 CSRF (double submit)

Rule (`core/csrf.py:csrf_violation`, applied by the middleware `main.py:819-852`): every state changing request (any method other than GET, HEAD, OPTIONS, TRACE) that carries the `tfm_mb_access` cookie must send the header `X-CSRF-Token` whose value equals a submitted `tfm_csrf` cookie value. Otherwise: `403` with `{"detail": {"code": "csrf_invalid", "message": "CSRF token missing or invalid"}}`. A present Origin that is not allow listed gives `403` `csrf_origin_rejected`. Exempt prefixes: `/oauth/`, `/v1/calendar/rsvp` (`main.py:797`).

Obtaining the token: `GET /auth/csrf` (`api/auth.py:1879`) answers `{"ok": true, "csrf_token": "<token>"}`, sets the `tfm_csrf` cookie and repeats the token in the `X-CSRF-Token` response header. Native clients read it from the JSON body. Mobile reference: `mailApi.ts:1006-1027`.

Client algorithm (mobile reference `mailApi.ts:1029-1103`):

1. Before the first non GET request, fetch `/auth/csrf` and cache the token. Also adopt a fresh `tfm_csrf` value whenever a response sets it (sign in, refresh).
2. Send `X-CSRF-Token: <token>` on every non GET request.
3. On `403` with `detail.code == "csrf_invalid"`: clear the cached token, fetch `/auth/csrf`, retry the request once.

### 1.2 Silent refresh

`POST /auth/mailbox/refresh` (`api/auth.py:2748`), no body, needs the `tfm_mb_refresh` cookie and the CSRF header. Success: `200 {"access_token": "<jwt>"}` and new cookies (`tfm_mb_access`, rotated `tfm_mb_refresh`, `tfm_csrf`). Rotation has a 15 second grace window for concurrent refreshes (`api/auth.py:2800` region, `_MAILBOX_ROTATION_GRACE`), so parallel 401s may all refresh safely, but the client should still coalesce them into one in flight refresh.

Client algorithm: on `401` for any request other than sign in, run the refresh once, then retry the original request once. If the refresh fails (401), the session is over: clear local state and show the signed out screen. Never loop. A transport failure during refresh is not a sign out.

### 1.3 Sign out

`POST /auth/mailbox/logout` (`api/auth.py:2871`), no body, CSRF header required. Answer `{"detail": "Signed out"}`. Revokes the refresh token and clears every retained account slot. The client must also delete all local cookies and the local cache even when this call fails (best effort).

## 2. Auth endpoints

### 2.1 Password sign in
`POST /auth/mailbox-login` (`api/auth.py:2492-2573`). Rate limit 5 per 60 s per IP (`rate_limit("auth:mailbox-login", 5, 60)`).
Request: `{"address": string, "password": string}` (`MailboxLoginRequest`, `api/auth.py:2486`). The client lowercases and trims the address.
Responses:
- `200 {"mailbox_id": uuid, "address": string, "org_id": uuid|null}` session established.
- `200 {"requires_2fa": true, "address": string}` password accepted, second factor needed (go to 2.4). The pending cookie `tfm_mb_2fa` was set.
- `401 {"detail": "Invalid address or password"}` (generic, covers unknown address, wrong password, inactive).
- `423` locked after repeated failures (`assert_mailbox_not_locked`, `api/auth.py:2514` region).
- `403 mfa_enrolment_required` when ICTA mandatory 2FA applies and the owner is not enrolled (`api/auth.py:2540` region); the native client shows "Set up two factor sign in on the web first."
- `429` rate limited.

### 2.2 Email a sign-in code
`POST /auth/mailbox-login-code/request` (`api/auth.py:4468`). Rate limit 5 per 300 s. Request `{"address": string}`. Always `200 {"detail": "If that mailbox exists, a sign-in code has been sent to its recovery email."}` (enumeration safe). The code goes to the owner's recovery addresses.

### 2.3 Verify a sign-in code
`POST /auth/mailbox-login-code/verify` (`api/auth.py:4507`). Rate limit 10 per 300 s. Request `{"address": string, "code": string}` (6 digits). Responses as 2.1 (session, or `requires_2fa` when the mandate applies). Wrong, expired or replayed code: `400 {"detail": "Invalid or expired code."}`.

### 2.4 Second factor
- `POST /auth/mailbox-2fa/challenge` (`api/auth.py:5222`). Rate limit 5 per 60 s. No body; needs the `tfm_mb_2fa` cookie. Emails a one time code to the owner's account email. `200 {"detail": "OTP sent to your email."}`. `401` when there is no pending session.
- `GET /auth/mailbox-2fa/context` (`api/auth.py:5257`). Reports what factors the pending owner has (authenticator or email). Optional in v1.
- `POST /auth/mailbox-2fa/verify` (`api/auth.py:5331`). Rate limit 10 per 60 s. Request `{"code": string}` (authenticator code, emailed code or a recovery code; the mobile client sends `{code: code.trim()}`, `mailApi.ts:1351`). Success `200` as 2.1 session body and cookies. Wrong code `400 {"detail": "Invalid or expired code."}`.

Passkeys (`/auth/mailbox-passkey/login/begin|complete`, `api/auth.py:6276,6293`) exist but are out of scope for v1 native clients.

### 2.5 Who am I
`GET /auth/mailbox/me` (`api/auth.py:2575`). `200`:
```
{ "mailbox_id": uuid, "address": string, "display_name": string|null, "org_id": uuid|null,
  "institution": string|null, "avatar_url": string|null,   // relative, e.g. /v1/avatars/mailbox/{id}.webp?v=3
  "must_change_password": bool, "needs_recovery_email": bool,
  "classification": string, "active_transfer": {id, state, new_address, progress}|null }
```
`401` means not signed in (try refresh first). The native client calls this at launch to validate the stored session. `must_change_password` and `needs_recovery_email` mean first login setup is outstanding: v1 shows "Finish account setup on the web" and blocks mail access (the server also enforces onboarding with `403 onboarding_required`).

### 2.6 Several mailboxes
- `GET /auth/mailbox/switchable` (`api/auth.py:3004`) `200 [{"mailbox_id", "address", "display_name", "avatar_url", "access": "send"|"full"}]` (`SwitchableMailbox`). The other mailboxes the signed in human can switch to without a password. Empty for shared mailboxes.
- `POST /auth/mailbox/switch` (`api/auth.py:3045`) request `{"mailbox_id": uuid}` (`MailboxSwitchRequest`), CSRF header, `200` same shape as `/auth/mailbox/me`, and new cookies. `403` when not entitled. After a switch the client must drop every cache keyed by the previous mailbox and reconnect the websocket.
- `GET /auth/mailbox/accounts` (`api/auth.py:3603`) lists added (password retained) accounts; add/remove (`/accounts/add`, `DELETE /accounts/{mailbox_id}`, `api/auth.py:3911,4050`) are not used in v1.

## 3. Errors, limits, pagination

### 3.1 Error shapes
FastAPI shapes, both seen:
- `{"detail": "message"}` (plain string, e.g. `api/auth.py:2506`, 400/401/404 on most routes).
- `{"detail": {"code": "snake_case", "message": "..."}}` (structured, `_auth_detail`, `api/auth.py:721`; CSRF, 409, onboarding). Clients branch on `code` when present.
- `422` validation: `{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}`.
The mobile parser (`mailApi.ts:984-1007`) is the reference: message = `detail` if string else `detail.message`; code = `detail.code` if present.

Codes the client must handle:

| Status | Code or meaning | Client behaviour |
|---|---|---|
| 401 | `not_authenticated` or plain text | refresh once, else signed out |
| 403 | `csrf_invalid` | refetch CSRF, retry once |
| 403 | `csrf_origin_rejected` | never sends Origin; treat as bug |
| 403 | `onboarding_required` | first login setup outstanding message |
| 404 | message or attachment not found | drop the row, refresh list |
| 409 | `mail_source_changed` (`api/inbox.py:6231`) | UIDVALIDITY changed: reload the folder, clear selection |
| 413, 415, 503 | `preview_too_large`, `preview_unsupported`, `preview_unavailable` (`api/inbox.py:5912`) | fall back to download |
| 422 | validation | show field message |
| 423 | mailbox locked | show message |
| 429 | rate limited, header `Retry-After` seconds (`core/ratelimit.py:109-170`) | back off for `Retry-After` |
| 502 | IMAP or relay failure (`_bad_gateway`, `api/inbox.py:6231`) | retry later, keep cached data |
| 503 | send briefly unavailable, `Retry-After` | retry later |

### 3.2 Rate limits (per IP unless noted)
Defined with `rate_limit(name, limit, window)` (`core/ratelimit.py:109`): sign in 5/60, sign in code request 5/300, code verify 10/300, 2fa challenge 5/60, 2fa verify 10/60, `inbox:conv-body` 240/60 (`api/inbox.py:4078`), `inbox:mark-thread-read` 120/60 (`api/inbox.py:4154`), `inbox:send` 60/60 (`api/inbox.py:5519`), `inbox:draft` 60/60 (`api/inbox.py:5877`), `inbox:schedule` 60/60 (`api/inbox.py:6274`), `inbox:image_proxy` 60/60. Other inbox routes have no named limit. Clients must debounce search and prefetch accordingly.

### 3.3 Pagination
List and search use `limit` (1 to 200, default 50) and `offset` (0 or more) (`api/inbox.py:1657-1666`). Responses carry `total`, `limit`, `offset`, `items`. The client requests the next page with `offset += items.count` until `offset + items.count >= total`. Conversation windows paginate backwards with `before` and `next_before` (section 5.3).

## 4. Folders

`GET /v1/inbox/{id}/folders?with_counts=true` (`api/inbox.py:1560`) `200 [FolderInfo]` (`api/inbox.py:255`):
```
{ "name": string, "path": string, "special_use": string|null, "unseen": int|null, "total": int|null }
```
`unseen` null means unknown (not zero). `special_use` is the IMAP role (`\Sent` style roles reduced to names such as `sent`, `drafts`, `trash`, `junk`, `archive`); when null, classify with the name aliases of `_folder_section_key` (`api/inbox.py:2315`): `inbox`; `sent`, `sent items`, `sent mail`; `drafts`, `draft`; `trash`, `deleted`, `deleted items`, `deleted messages`, `bin`; `junk`, `spam`, `junk email`, `junk e-mail`.

`GET /v1/inbox/{id}/folder-counts` (`api/inbox.py:2283`) `200 [{"path", "unseen", "total"}]`. Cheap, cached server side, meant for badge polling (the Dock badge uses INBOX unseen).

`GET /v1/inbox/{id}/quota` (`api/inbox.py:1936`) `200 {"used_bytes", "limit_bytes"|null, "percent"|null}`.

`POST /v1/inbox/{id}/folders/mark-read?folder=` (`api/inbox.py:1620`) and `POST /folders/empty` (`api/inbox.py:1596`, Trash and Junk only) are not used in v1 UI except mark all read.

## 5. Messages

### 5.1 Thread (conversation) list
`GET /v1/inbox/{id}/conversations?folder=INBOX&limit=50&offset=0&q=&category=` (`api/inbox.py:1818`) `200 ConversationListResponse` (`api/inbox.py:532`):
```
{ "folder": string, "total": int /* conversations */, "limit": int, "offset": int,
  "items": [ { "thread_key": string, "latest": EnvelopeItem, "count": int, "unread": bool, "uids": [int] } ],
  "incomplete": bool, "scanned": int|null, "candidates": int|null, "errored": int|null, "incomplete_reason": string|null }
```
`EnvelopeItem` (`api/inbox.py:264`):
```
{ "uid": int, "folder": string, "message_id": string, "subject": string, "from_name": string, "from_addr": string,
  "to": [string], "date": string, "seen": bool, "flagged": bool, "answered": bool, "keywords": [string],
  "important": bool, "has_attachments": bool, "snippet": string,
  "category": "primary"|"updates"|"external",
  "auth_level": "warning"|"danger"|null, "auth_code": string|null,
  "sender_verified": bool, "auth_warned": bool }
```
The native v1 thread list uses `/conversations` (thread collapsed). The flat `GET /messages?folder&limit&offset&category` (`api/inbox.py:1657`, `MessageListResponse`, same item shape, plus `total`) is the fallback and is used for Sent and Drafts where a conversation row adds nothing.

### 5.2 Search
`GET /v1/inbox/{id}/search?q=&folder=INBOX&limit=50&offset=0&category=` (`api/inbox.py:2213`) `200 MessageListResponse` (`api/inbox.py:303`). `q` max length 256. Supports operators (`from:`, `to:`, `subject:`, `has:attachment`, `label:`; parsed by `imap_service._parse_search_query`). The server searches ONE folder per call (`folder` is a single IMAP path; there is no all-mail mode). Clients that offer "all folders" fan out one call per folder (excluding Junk and Trash) and merge by date. A `has:attachment` search may answer `incomplete: true` with `incomplete_reason` (`time`, `ceiling`, `errors`, `busy`): the client shows "Showing the newest matches only." Cancel in flight searches when the query changes. `GET /search/suggest?q=&limit=` (`api/inbox.py:2062`) offers completions (optional).

### 5.3 Conversation window (reader)
`GET /v1/inbox/{id}/conversation?uid=&folder=&limit=10&before=&mark_seen=true&bodies=anchor` (`api/inbox.py:3936`). `limit` 1 to 100, `bodies` is `anchor` (default: metadata shells for the window plus the anchor body inline), `none` (shells only) or `all` (full bodies). `mark_seen` (default true) marks the anchor read server side. Response `ConversationWindow` (`api/inbox.py:589`):
```
{ "messages": [ MessageDetail | ConversationMessage ], "source_uidvalidity": int|null,
  "total": int, "has_more_older": bool, "next_before": int }
```
`ConversationMessage` (shell, `api/inbox.py:555`): `uid, folder, source_uidvalidity, seen, flagged, answered, from_name, from_addr, to, cc, subject, date_ts (epoch s), size, message_id, has_attachments, snippet, auth_level, auth_code, sender_verified, auth_warned, body (ConversationMessageBody|null)`.
`MessageDetail` (`api/inbox.py:441`): `uid, folder, source_uidvalidity, subject, from_name, from_addr, to, cc, bcc, file_ids, date, seen, flagged, answered, keywords, important, message_id, reply_to, mailed_by, signed_by, security, smime, smime_decrypted, auth_warning (AuthWarning|null), sender_verified, references, text|null, html|null, attachments [Attachment], is_invitation`.
`Attachment` (`api/inbox.py:409`): `{part_id, filename, content_type, size}`.
`AuthWarning` (`api/inbox.py:421`): `level: info|warning|danger, code, title, message, claimed_domain, reasons [{code,label}], spf, dkim, dkim_domain, dkim_aligned, dmarc, dmarc_policy, links_disabled, client_ip, client_host`.
Older page: call again with `before = next_before` while `has_more_older`. The response carries `ETag` and `Cache-Control: private, max-age=20` (`api/inbox.py:140`).

Lazy body: `GET /v1/inbox/{id}/conversation/{uid}/body?folder=` (`api/inbox.py:4075`, rate limit 240/60) `200 ConversationMessageBody` (`MessageDetail` plus `date_ts`). Used when expanding a collapsed message.

Single message: `GET /v1/inbox/{id}/messages/{uid}?folder=` (`api/inbox.py:2497`, registered at `api/inbox.py:4752`) `200 MessageDetail`.

### 5.4 Mark read on open
Two ways; v1 uses the first:
- `POST /v1/inbox/{id}/conversation/{uid}/mark-read?folder=&sender=&expected_uidvalidity=` (`api/inbox.py:4151`) `200 {"marked": int, "folders": {folder: count}, "uids": {folder: [uid]}, "complete": bool, "failed_folders": [string]}` (`MarkThreadReadResponse`, `api/inbox.py:604`). Thread wide.
- `POST /v1/inbox/{id}/messages/{uid}/flags?folder=` body `{"seen": bool|null, "flagged": bool|null, "sender": string|null}` (`FlagsRequest`, `api/inbox.py:640`, route `api/inbox.py:4759`) `200 {"ok": true}`.
Client contract: apply the read state locally first, send the request, restore the previous state if it fails (non 2xx, or `complete == false` for the folder of the opened message), and show a non blocking notice.

### 5.5 Actions (single and batch)
Single (all `200 {"ok": true}`, CSRF header, `folder` query is the message's current folder, optional `expected_uidvalidity` query integer):
- Flags: `POST /messages/{uid}/flags` (above). Star is `flagged`, read state is `seen`.
- Move: `POST /messages/{uid}/move` body `{"to_folder": string}` (`MoveRequest`, `api/inbox.py:651`, route `api/inbox.py:4893`).
- Archive: `POST /messages/{uid}/archive` (`api/inbox.py:4950`); the server resolves or creates the Archive folder.
- Delete (soft, to Trash): `DELETE /messages/{uid}` (`api/inbox.py:5007`). Permanent: `DELETE /messages/{uid}/permanent` (`api/inbox.py:5055`) only from Trash.
- Junk: `POST /messages/{uid}/spam` (`api/inbox.py:5107`); not junk: `POST /messages/{uid}/not-spam` (`api/inbox.py:5164`).
Batch (one IMAP session; up to 200 UIDs, `MAX_BATCH_UIDS`, `api/inbox.py:668`): `POST /messages/batch/flags|move|archive|delete|permanent|spam|not-spam` (`api/inbox.py:4265-4592`), body `{"uids": [int], "expected_uidvalidity": int|null}` plus `seen`/`flagged` for flags, `to_folder` for move. Response `BatchResponse` (`api/inbox.py:730`): `{"ok": bool, "requested": int, "succeeded": [uid], "failed": [{"uid", "reason"}]}`; `ok: false` is a partial success, still HTTP 200. `reason` is one of `not_found`, `store_failed`, `move_failed`, `purge_failed`. `409 mail_source_changed` refuses the whole batch.
Undo: the inverse call (move back to the source folder, flags inverse). A moved message gets a new UID in the destination; the move response does not return it in v1, so undo of a move re-reads the destination list. Delete undo is a `move` out of Trash with the message found by `message_id` through `GET /messages/resolve?message_id=&folder=` (`api/inbox.py:2419`, `ResolvedMessage`).

### 5.6 Attachments
- Download or inline: `GET /v1/inbox/{id}/attachments/{uid}/{part_id}?folder=&inline=false` (`api/inbox.py:6023`) streams the bytes with `Content-Type` and `Content-Disposition`. Authenticated by the session cookies, so the client downloads with its cookie session (not a browser).
- Office preview as PDF: `GET /attachments/{uid}/{part_id}/preview?folder=` (`api/inbox.py:5912`); PDFs pass through; errors 415/413/503 (section 3.1).
Quick Look on macOS: download to a temporary, app private file with the original filename, hand it to `QLPreviewPanel`, delete on sign out and at launch.

### 5.7 Avatars
`POST /v1/inbox/{id}/avatars/batch` (`api/inbox.py:2126`) body `{"emails": [string]}` (at most 100, `AvatarBatchRequest`, `api/inbox.py:955`) `200 {"results": {email: {"url": string|null, "name": string|null, "url_scope"?: "platform", "institution"?: {"name": string|null, "logo_url": string}}}}`. `url` and `logo_url` are server relative or absolute image URLs served from Taifa storage (`GET /v1/avatars/{kind}/{entity_id}.webp?s=`, `api/avatars.py:287`, immutable cache `max-age=31536000`). The decision rule is in DESIGN_SPEC section 7.

## 6. Compose and send

- Send: `POST /v1/inbox/{id}/send` (`api/inbox.py:5516`, rate limit 60/60). Body `SendRequest` (`api/inbox.py:761`): `to [string] (min 1), cc [string]|null, bcc [string], subject (max 998), text|null, html|null, in_reply_to|null, references|null, reply_uid|null, reply_folder|null, file_ids [uuid]|null, omit_header: bool, smime_sign: bool, smime_encrypt: bool`. Addresses are validated server side (`_validate_addresses`); a bad one gives `422`. `200 SendResponse` (`api/inbox.py:836`): `{"ok": true, "message_id": string, "suppressed": [string], "refused": [string]}`. Fully suppressed recipients: `403`. Relay rejection of all recipients: `502`. Native v1 leaves `smime_*` false and `omit_header` false.
- Pre flight: `POST /v1/inbox/{id}/send-preflight` (`api/inbox.py:2034`) body `{"recipients": [string]}` `200 {"warning": object|null}`; optional in v1 (external recipient warning on classified mailboxes).
- Save draft: `POST /v1/inbox/{id}/drafts` (`api/inbox.py:5874`, rate limit 60/60). Body `DraftRequest` (`api/inbox.py:794`): the send fields with `to` optional, plus `replace_uid: int|null` (delete the previous copy after saving) and `op_id` (8 to 64 chars `[A-Za-z0-9_.:-]`, makes a retried save idempotent). `200 {"uid": int|null, "folder": string}`. Re-save with `replace_uid` set to the last returned uid. Delete a draft with the normal message delete (`DELETE /messages/{uid}?folder=Drafts`, which moves it to Trash). An opened draft's `MessageDetail` carries `bcc` and `file_ids`.
- Attachments for compose (large files and all uploads): three steps against `/v1/files/` (`api/files.py:119,167`):
  1. `POST /v1/files/` body `{"filename", "mime", "size": int (>0), "access": "link"|"authenticated", "mailbox_id": uuid, "expires_in_days": int|null}` (`CreateUploadRequest`, `api/files.py:54`) `201 {"file": {id, filename, mime, size_bytes, status, access, scan_verdict?}, "upload": {"url", "method", "headers": {}}, "seal"?: ...}`.
  2. Upload the bytes to `upload.url` with `upload.method` and exactly `upload.headers` (object storage presigned URL; no cookies, no CSRF header, no extra headers).
  3. `POST /v1/files/{file_id}/complete` `200 {"file": ...}`; when `status` is `ready` (scan done) the id may be sent in `file_ids`. Remove with `DELETE /v1/files/{file_id}`.
  Small files are attached inline by the server, large ones become signed links (`api/inbox.py:775` comment). Forwarding a message with its attachments: `POST /v1/inbox/{id}/messages/{uid}/stage-attachments?folder=` (`api/inbox.py:6071`) `200 {"files": [{file_id, filename, content_type, size}]}`, then pass the `file_id`s.
- Scheduled send (out of v1 UI): `POST /scheduled` (`api/inbox.py:6271`), `GET /scheduled` (`api/inbox.py:6363`).
- Address suggestions: `GET /v1/mailbox/contacts/?q=&limit=` (mobile `mailApi.ts:2154`), personal address book; fall back to addresses seen in the current thread.

## 7. Settings the v1 app reads and writes

- `GET /v1/mailbox/settings` (`api/mailbox_settings.py:602`) `200 MailboxSettingsResponse`: `id, display_name, address, quota {used_bytes, limit_bytes, percent}, client_settings {...}, avatar_version, avatar_url, inbox_style, inbox_style_chosen, inbox_category_tabs, stamp_classification, trusted_image_senders [string], guides_seen, theme, text_size, locale, timezone, blocked_sender_*` (field list from `mailApi.ts:365-398`). `PATCH` same path (`api/mailbox_settings.py:617`) updates preferences; the native app keeps theme and density locally in v1 and does not write them.
- Signature: `GET /v1/mailbox/blocks` (`api/mailbox_settings.py:1611`) `200 {"signatures": [Block], "headers": [Block], "footers": [Block]}`; `Block`: `id, block_type: signature|header|footer, name, html, config|null, text|null, is_default, scope: mine|org, enforced, created_at, updated_at`. Create `POST /v1/mailbox/blocks` (`api/mailbox_settings.py:1651`, `201`), body `{"block_type", "name", "html"?, "text"?, "is_default"?}`; update `PATCH /v1/mailbox/blocks/{id}` (`api/mailbox_settings.py:1686`); delete `DELETE` (`api/mailbox_settings.py:1729`, `204`). The default signature is `is_default == true` and `block_type == "signature"`.
- Auto reply: `GET /v1/mailbox/autoresponder` (`api/mailbox_settings.py:1791`) and `PUT` same path (`api/mailbox_settings.py:1801`): `{"enabled": bool, "subject": string, "html": string, "text": string, "mode": "always"|"outside_hours"|"date_range", "start_at": string|null, "end_at": string|null, "days": [int], "start_hour": int, "end_hour": int}` (`mailApi.ts:422-433`).
- Trusted image senders: `trusted_image_senders` in the settings response; `POST /v1/mailbox/settings/trusted-senders` adds one (mobile `mailApi.ts:1212`). The native app honours the list when deciding whether to load remote images.

## 8. Realtime: websocket `/ws/mailbox`

`wss://mail.govconnect.ke/ws/mailbox` (`main.py:1149`). Authentication: the `tfm_mb_access` cookie on the upgrade request (preferred; the native client attaches the cookies from its cookie store), or `?token=<jwt>` where the token is a `mailbox_access` token. Failure closes with code `4001` (invalid token or inactive mailbox; the client refreshes the session once and reconnects, and signs out if the refresh fails), `4003` (central workforce access unavailable, or onboarding required: `MAILBOX_WS_ONBOARDING_CLOSE_CODE = 4003`, `main.py:420`).

Frames (JSON text):
- On connect the server sends `{"type": "connected", "message": "Listening for mailbox updates"}`.
- Keep alive: the client sends the text `ping` every 30 s; the server answers `{"type": "pong"}`. No pong within 10 s means the socket is dead: close and reconnect with exponential backoff (mobile reference `mailboxRealtime.ts:60-125`).
- Events (mailbox scoped; ignore events whose `mailbox_id` is present and differs from the active mailbox):

| `type` | Fields | Source |
|---|---|---|
| `mailbox_message_new` | `mailbox_id, folder ("INBOX"), reason, timestamp, message?` (envelope of the delivery when it could be resolved) | `api/inbound.py:701` |
| `mailbox_message_sent` | folder unspecified; Sent list is stale | webmail `cache.ts` handler |
| `mailbox_flags_changed` | `uid, folder, seen, flagged, flags`; thread wide variant `thread: true, uids: {folder: [uid]}, complete` | `api/inbox.py:4198,4295,4789` |
| `mailbox_important_changed` | `uid, folder, important` | `api/inbox.py:4353,4868` |
| `mailbox_message_moved` | `uid, from_folder, to_folder` | `api/inbox.py:4400,4923` |
| `mailbox_message_deleted` | `uid, folder` | `api/inbox.py:4493,5036` |
| `mailbox_message_purged` | `uid, folder` | `api/inbox.py:4533` |
| `mailbox_folder_emptied` | `folder, deleted` | `api/inbox.py:1615` |
| `mailbox_folder_read` | `folder, marked` | `api/inbox.py:1641` |
| `mailbox_draft_saved` | `folder, uid` | `api/inbox.py:5904` |

Rules: realtime is an optimisation, REST is the source of truth. UIDs are folder local, so an event without a folder must not patch a row; mark the lists stale and refetch. After every reconnect, and on a 60 s poll while the socket is down, run a REST reconcile (folder counts plus the visible list's first page). Never show a notification for a `mailbox_message_new` that the REST reconcile cannot confirm as unseen in INBOX.

## 9. Not in v1

Passkeys, labels, snooze, scheduled send UI, S/MIME, calendar, contacts management, AI endpoints, push registration (native notifications come from the websocket and the poll while the app runs), app passwords, 2FA enrolment, account add/remove.

## 10. Fixtures

The macOS app tests use JSON fixtures copied from the models above (`macos/TaifaMailTests/Fixtures`). They contain fake data only (`example.go.ke` style addresses). The Windows app should reuse the same files.
