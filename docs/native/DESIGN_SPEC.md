# Taifa Mail native clients: design spec

Status: v1, shared by the macOS app (Swift, SwiftUI, AppKit) and the Windows app (WinUI 3 or equivalent native stack). Everything here is platform neutral unless a section says otherwise. The API behaviour is in `API_CONTRACT.md`.

Hard rules (from the owner):

- Native controls only. No Electron, no Tauri, no webview showing the webmail, no HTML/CSS app UI.
- The only web content is the HTML body of a received message, in a locked-down view (section 13).
- Spacing and surfaces follow spaci's rules (adapted below), colours follow the Taifa brand.
- Icons come only from the Iconsax library (rounded, linear), vendored per project. Directional affordances are chevrons only.
- No em dashes anywhere (code, comments, docs, UI copy).

## 1. Spacing

One scale. Every padding, margin and gap is one of these values (points on macOS, effective pixels on Windows).

| Token | Value | Use |
|---|---|---|
| `space.1` | 4 | icon to label, chip to chip, tight stacks |
| `space.2` | 8 | label to field, row inner gaps, toolbar item gap |
| `space.3` | 12 | between groups inside a card or panel, row vertical padding |
| `space.4` | 16 | panel edge padding, between form fields |
| `space.5` | 20 | between sections of a panel |
| `space.6` | 24 | window content margin (reader, compose, settings) |
| `space.8` | 32 | between major blocks, empty state gaps |

Rhythm (from spaci and the Taifa web tokens): 4 to 8 inside a group, 12 to 16 between groups, 16 to 24 between sections, 24 to 32 between major blocks. Hairlines (1) are the only raw values allowed outside the scale. Text never clips mid word: single line labels truncate with an ellipsis, long strings (addresses, subjects in the reader) wrap anywhere.

## 2. Type

Font: Google Sans for UI where bundled, otherwise the system font (SF Pro on macOS, Segoe UI Variable on Windows). JetBrains Mono for addresses, message ids and keyboard hints. Spaci tightens tracking by -0.1; do the same at 13 and above.

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `type.caption` | 11 / 14 | 500 | counts, timestamps in dense rows, badges |
| `type.meta` | 12 / 16 | 400 | snippet, header meta lines, sidebar secondary |
| `type.body` | 13 / 18 | 400 | list rows, sidebar rows, settings labels |
| `type.bodyStrong` | 13 / 18 | 600 | unread sender and subject, selected row title |
| `type.reader` | 14 / 22 | 400 | native plain text bodies |
| `type.title` | 16 / 22 | 600 | reader subject, section titles |
| `type.display` | 20 / 26 | 600 | sign-in title, empty state title |
| `type.hero` | 24 / 30 | 600 | sign-in wordmark line only |

Plain text bodies use `type.reader`; HTML bodies set a 14px base font through injected CSS so both look alike.

## 3. Colour tokens

Neutral surfaces follow spaci (warm neutrals, no grain on macOS), accent and semantic colours follow the Taifa brand. Black `#050100`, red `#860000`, green `#006900`. Fills on green always carry white ink. In dark the green used as a foreground (text, icon, unread dot, focus ring) is brightened to `#1ea94e`; the filled button stays `#006900` so white ink keeps contrast.

| Token | Light | Dark |
|---|---|---|
| `bg` (window, reader backdrop) | `#F8F3F0` | `#0E0C0B` |
| `panel` (list, reader card, compose) | `#FFFFFF` | `#161312` |
| `panel2` (hover, inputs, sidebar tint) | `#F1EBE5` | `#1D1A18` |
| `panel3` (pressed, chips) | `#E7DED5` | `#262321` |
| `border` | `#E7DED4` | `#2B2725` |
| `border2` (inputs, focus neighbours) | `#D6CBBF` | `#3A3532` |
| `text` | `#050100` | `#F8F3F0` |
| `text2` | `#5B5650` | `#B6B1AB` |
| `text3` (meta, 4.5:1 on panel) | `#6A655E` | `#9D978F` |
| `text4` (decorative only, never text) | `#8F8A83` | `#7A756E` |
| `accent` (filled surfaces) | `#006900` | `#006900` |
| `accentHover` | `#005A00` | `#007A00` |
| `onAccent` | `#FFFFFF` | `#FFFFFF` |
| `accentFg` (text, icons, unread dot) | `#006900` | `#1EA94E` |
| `accentSoft` (selection tint) | `rgba(0,105,0,0.08)` | `rgba(30,169,78,0.14)` |
| `accentSoft2` (selection, focused list) | `rgba(0,105,0,0.14)` | `rgba(30,169,78,0.22)` |
| `danger` (filled) | `#860000` | `#A31212` |
| `dangerFg` | `#860000` | `#E8836F` |
| `dangerSoft` | `rgba(134,0,0,0.10)` | `rgba(232,131,111,0.16)` |
| `warn` | `#B8862A` | `#D9A441` |
| `warnFg` | `#86600F` | `#E6B85C` |
| `warnSoft` | `rgba(184,134,42,0.13)` | `rgba(217,164,65,0.16)` |
| `flag` (starred) | `#B8862A` | `#E6B85C` |
| `track` (skeleton base) | `rgba(120,110,100,0.16)` | `rgba(140,140,140,0.16)` |

Warnings are amber, never brand colours. Red is for danger and the auth `danger` verdict only.

## 4. Radii

`radius.xs` 4 (tags, badges), `radius.ctl` 8 (controls, inputs, list rows), `radius.card` 12 (cards, grouped blocks, message cards in the reader), `radius.panel` 16 (sheets, sign-in card), `radius.pill` (chips, avatars, token chips). Institution logo tiles use `radius.ctl` scaled to the tile (25 percent of the side, minimum 6).

## 5. Selection and focus

- Selected row: `accentSoft` background, 1 hairline `border2` at 60 percent opacity, `radius.ctl`. Never a heavy outline, never a solid accent fill with inverted text.
- Selected row in a focused list: `accentSoft2` background, same hairline.
- Hover: `panel2`.
- Keyboard focus ring on controls: 2 `accentFg` at 70 percent, offset 1. Lists use the selection style, not a ring.
- Unread: 8 point dot in `accentFg` at the leading edge of the row, sender and subject at `type.bodyStrong`.
- Pressed: `panel3`.

## 6. Sizes

Row heights (points):

| Element | Height |
|---|---|
| Sidebar row | 32 (icon 16, label `type.body`, count `type.caption`) |
| Sidebar section header | 24 |
| Thread row, comfortable | 76 (3 lines: sender and time, subject, snippet) |
| Thread row, compact | 52 (2 lines: sender and time, subject plus snippet inline) |
| Thread list avatar | 36 comfortable, 28 compact |
| Reader header (collapsed message) | 56 |
| Reader header (expanded message) | 72 minimum, grows with recipients |
| Reader avatar | 40 |
| Toolbar item | 28 hit height, 32 minimum width |
| Compose token chip | 24 |
| Attachment chip | 40 |
| Text field | 32 |
| Primary button | 32 (36 on sign-in) |

Column widths (macOS split view): sidebar 200 min, 220 ideal, 280 max; thread list 300 min, 360 ideal, 480 max; reader 420 min. Minimum window 900 x 600, default 1280 x 800.

## 7. Avatars

One decision, one place (port of the webmail `senderPicture`, webmail/src/mail/sender-logo.ts and the mobile model):

1. Resolve an entry for the address from `POST /v1/inbox/{id}/avatars/batch` (`url`, `name`, optional `url_scope: "platform"`, optional `institution {name, logo_url}`).
2. Outgoing (the Sent folder, and compose recipients): the avatar stands for the correspondent, so no trust rules apply. Photo if `url`, else the institution logo if present, else placeholder.
3. Incoming, message has an auth warning at any level (`auth_level` set, `auth_warning` present, or `auth_warned` true): placeholder only.
4. Incoming, no warning, `sender_verified == true` means verified.
5. Photo shown when `url` is present and not (`url_scope == "platform"` and not verified).
6. Institution logo shown only when there is no `url`, the message is verified and the entry has `institution.logo_url`.
7. Otherwise placeholder.
8. Entry not yet answered: placeholder, marked pending (no flash when it resolves).

Shapes at the same size: a person photo is a circle; an institution logo is a contained rounded tile (aspect fit inside the tile, `panel2` background, never cropped to a face); the placeholder is a circle with the initial (first letter of name, else address) in white on a deterministic colour. Deterministic colour: FNV-1a 32 bit hash of the lowercased address modulo 8, into this palette (same in light and dark): `#006900 #7A4B00 #00555E #4A3B8F #8A2B55 #2F5D8A #5A6B00 #7B3F2A`. Image loads are cached on disk and in memory, decoded off the main thread, downsampled to 2x the display size.

## 8. Screens and states

Every data screen has these states: loading (skeleton), loaded, empty, error, offline. Auth screens have loading, error and field-level validation. Copy below is final UI copy.

### 8.1 Sign in
- Layout: centred card 400 wide, `radius.panel`, padding `space.6`, wordmark above, fields 32 high, primary button full width.
- Fields: mailbox address (monospace), password. Actions: "Sign in", "Email me a sign-in code".
- Loading: button shows a spinner, fields disabled.
- Error: inline banner above the button, `dangerSoft`. 401 "Invalid address or password"; 423 locked "This mailbox is temporarily locked. Try again later."; 429 "Too many attempts. Wait a minute and try again."; transport "Could not reach Taifa Mail."
- Offline: banner "You are offline. Connect to sign in." and the button is disabled.
- Passkeys: omitted in v1. A one line note under the actions: "Passkey sign-in is not available in this version."

### 8.2 Sign-in code
- Step 1 asks for the address (prefilled), "Send code". Always shows the generic confirmation "If that mailbox exists, a sign-in code has been sent to its recovery email." (the server is enumeration safe).
- Step 2: 6 digit code field, "Verify". Errors: "Invalid or expired code." (400), rate limit message (429).

### 8.3 Second factor
- Shown when sign-in or code verify answers `requires_2fa`. One field "Verification code", "Verify", secondary "Email me a code" (calls the challenge endpoint; confirmation "A code was sent to your account email."). Accepts authenticator codes, emailed codes and recovery codes. Errors as 8.2.

### 8.4 Main window (three columns)
- Sidebar, thread list, reader. Sidebar material on macOS (`.sidebar` list style); on Windows Mica with the sidebar as a NavigationView pane.
- Sidebar top: mailbox switcher (avatar 28, display name, address in `type.meta`, chevron down) when `GET /auth/mailbox/switchable` returns siblings, otherwise a static identity block. Then folders in fixed order Inbox, Drafts, Sent, Archive, Junk, Trash, then other folders under a "Folders" header. Counts: unseen only, `type.caption`, hidden at 0, `99+` cap. Drafts shows total instead of unseen.
- Special use icons: Inbox, Drafts, Sent, Archive, Junk, Trash from the Iconsax mail set; other folders get the folder icon.
- Loading: 6 skeleton sidebar rows, 8 skeleton thread rows (avatar disc, two bars), reader shows the empty "no selection" state.
- Empty list: icon, "Nothing here" title, one line hint ("This folder has no messages." or "No messages match your search.").
- Error: inline banner at the top of the list with "Retry"; cached rows stay visible if any.
- Offline: banner under the toolbar "Offline. Showing the last synced mail." (`warnSoft`); mutating actions are disabled with a tooltip "Not available offline".
- Signed out (session expired and refresh failed): the whole window swaps to 8.1 with a banner "Your session ended. Sign in again."

### 8.5 Thread list
- Row content: avatar, sender (or recipient in Sent and Drafts), time right aligned, subject, snippet, attachment icon (paperclip glyph from the library) and flag at the trailing edge, unread dot at the leading edge, thread count badge when more than one message.
- Time format: today `HH:mm`, yesterday "Yesterday", this week the weekday, this year `d MMM`, older `d MMM yyyy`.
- Multi select: shift and command click; toolbar swaps to batch actions; header shows "N selected".
- Infinite scroll: next page requested when the 10th row from the end appears; footer spinner while loading; footer "No more messages" is not shown.
- Pull to refresh equivalent: Cmd+R, the toolbar refresh button, and on Windows F5 plus pull gesture on touch.
- Rows are lazy, fixed height, so scrolling thousands of rows stays cheap.

### 8.6 Reader
- Header block per message: avatar, sender name and address (monospace), "to" line collapsing to "to me, +2", date, attachment and flag state.
- Conversation: earlier messages collapsed to their 56 high header and first line of snippet, latest expanded. Click a collapsed header to expand. "Show earlier messages" when the window has more.
- Opening a thread marks it read immediately and optimistically. If the request fails the unread state is restored and a quiet banner "Could not mark as read" appears.
- Auth banner: `info` (neutral), `warning` (amber), `danger` (red) per `auth_warning.level`, with title and message; at `links_disabled` links are inert.
- Remote images: a banner "Remote images are blocked. Show images" for this message only (never persisted across messages unless the sender is trusted in settings).
- Attachments: chips below the body (icon, name, size). Click or Space previews (Quick Look on macOS, preview pane on Windows), a download button saves to a chosen location.
- Loading: skeleton header and 5 body bars. Empty (no selection): large mail icon and "Select a message". Error: card with "Could not load this message" and Retry. Offline: opened messages come from cache; uncached ones show "This message is not available offline."

### 8.7 Compose
- Separate window (macOS) or dialog window (Windows), 640 x 560 default.
- Rows: From (read only, or a picker if several send identities), To, Cc, Bcc (Cc and Bcc revealed by a link), Subject, body editor, attachment strip, footer with Send.
- Recipients are token chips (`radius.pill`, 24 high) with address suggestions from the mailbox's contact search; invalid addresses show a `dangerSoft` chip.
- Editor: rich text with bold, italic, bulleted and numbered lists, links. Output is HTML plus a plain text alternative.
- Attachments: drag and drop onto the window or the attach button picker; each shows name, size, progress, remove.
- Drafts autosave to the server after 3 seconds of idle and on window close; footer shows "Saved" or "Saving".
- Sending: button becomes "Sending" with a spinner, fields disabled; success closes the window; failure keeps the window, shows an inline `dangerSoft` banner with the server message and re-enables Send. Partial refusals (`suppressed` or `refused` not empty) show a `warnSoft` notice listing the addresses.
- Reply, Reply all, Forward prefill recipients, subject (Re:, Fwd:), quoted body, `in_reply_to`, `references`, `reply_uid`, `reply_folder`.

### 8.8 Search
- Search field in the toolbar (Cmd+F focuses it; Shift+Cmd+F searches all folders). Results use the thread list rows. Scope control: current folder, or all folders (client side fan out, see API_CONTRACT 5.2). Empty result: "No messages match". Loading shows skeleton rows. Cancel with Escape returns to the folder.

### 8.9 Settings
- Window with a sidebar of panes: General (theme system, light, dark; list density comfortable, compact), Notifications (new mail alerts on or off, Dock badge on or off), Signature (editor, saved through the mailbox blocks API), Auto-reply (enabled, subject, message, mode and schedule), Account (address, institution, quota bar, sign out).
- Each pane has loading, error and saved states (inline "Saved" confirmation).

### 8.10 Offline
- Network lost: banner described in 8.4, cached folders, lists and opened messages stay readable, queued reads only (no offline mutations in v1). Realtime reconnects with backoff and a REST reconcile runs on reconnect.

## 9. Toolbar, menus, shortcuts

Toolbar (unified, macOS): leading: sidebar toggle; list column: compose, refresh; reader column: archive, delete, junk, move to folder menu, flag, mark unread, reply, reply all, forward; trailing: search field. Windows uses a command bar with the same grouping.

macOS shortcuts and menu bar (File, Edit, View, Message, Mailbox, Window, Help):

| Action | macOS | Windows |
|---|---|---|
| New message | Cmd+N | Ctrl+N |
| Reply | Cmd+R | Ctrl+R |
| Reply all | Shift+Cmd+R | Ctrl+Shift+R |
| Forward | Shift+Cmd+F | Ctrl+F (when a message is focused) |
| Refresh | Cmd+R is Reply, so refresh is Shift+Cmd+K | F5 |
| Send (in compose) | Shift+Cmd+D | Ctrl+Enter |
| Archive | Ctrl+Cmd+A | E |
| Delete | Cmd+Delete | Delete |
| Junk | Shift+Cmd+J | Ctrl+J |
| Flag | Shift+Cmd+L | Ctrl+Shift+G |
| Mark unread | Shift+Cmd+U | Ctrl+U |
| Mark read | Shift+Cmd+U toggles | Ctrl+Q |
| Search in folder | Cmd+F | Ctrl+E |
| Search all mail | Option+Cmd+F | Ctrl+Shift+F |
| Next / previous message | Down / Up | Down / Up |
| Open selected thread | Return | Enter |
| Settings | Cmd+, | Ctrl+, |
| Close window | Cmd+W | Ctrl+W |
| Undo (last action) | Cmd+Z | Ctrl+Z |

Note: the macOS bindings follow Mail.app (Cmd+R reply, Shift+Cmd+R reply all, Shift+Cmd+F forward, Cmd+F search), so refresh is Shift+Cmd+K and all-mail search is Option+Cmd+F. The Windows app follows Outlook (Ctrl+R, Ctrl+Shift+R, Ctrl+F forward, Ctrl+E search).

Undo: archive, delete, junk, move and flag changes can be undone while the toast "Moved to Trash. Undo" is visible (8 seconds) and through Cmd+Z, using the inverse call (`move` back to the source folder, `flags` inverse).

## 10. Platform conventions

macOS (14+): `NavigationSplitView` with three columns, unified toolbar (`.windowToolbarStyle(.unified)`), sidebar material, hidden inset title bar with traffic lights at x 18, y 22 (same as spaci), full menu bar, Settings scene (Cmd+,), `UserNotifications` for new mail, Dock badge for the Inbox unread count, Quick Look for attachments, drag and drop for attachments, system accent is not used (brand green is the accent).

Windows (10 22H2 and 11): `NavigationView` for the folder pane, Mica backdrop, custom title bar integrated with the toolbar (extend content into the title bar, drag region over the empty toolbar area), Fluent controls, Settings as a page in a second window or a navigation destination, toast notifications, taskbar badge overlay for unread count, drag and drop for attachments. List virtualisation is mandatory (ItemsRepeater or ListView with fixed item size).

## 11. Icons

Library: `icons/rounded/linear/<category>/iconsax-<name>-<hash>-.svg`. One shape (rounded) and one variant (linear) per project. Each client vendors the SVGs it uses as separate files behind an `Icon` wrapper with a NOTICE; nothing references the library path at runtime. Stroke width is the library's 1.5 on a 24 grid, rendered at 16 (sidebar, toolbar compact), 18 (toolbar), 20 (list trailing), 24 (empty states).

Arrows are chevrons only: `arrow-down4`, `arrow-up3`, `arrow-right4` and `arrow-left4`. Gap: the library has no `arrow-left4` in `rounded/linear` (it exists in the other variants). Clients draw it by mirroring `arrow-right4` horizontally; do not substitute a tailed arrow or an SF Symbol or Segoe icon. Tailed arrows (`arrow-down`, `arrow-up2`) and circled or squared arrows are never used for navigation.

SF Symbols and Segoe Fluent icons are not used where the library has the glyph.

## 12. Motion and performance budget

- Transitions 120 to 180 ms ease out, none on list scrolling. Respect reduced motion.
- Skeletons use a static `track` fill with a slow 1.2 s opacity pulse.
- Targets: cold launch to cached inbox under 1 s; scrolling 5,000 rows at 60 fps with no main thread network or image decoding; thread selection to rendered body under 150 ms when cached.

## 13. The message body view

- The only web content in the app. WKWebView on macOS, WebView2 on Windows.
- JavaScript disabled (macOS `allowsContentJavaScript = false`, Windows `IsScriptEnabled = false`).
- No navigation inside the view. Link activation is intercepted and cancelled; the URL opens in the system browser after a visible host check: the user sees a confirmation sheet "Open link to host.example?" with the real host (punycode decoded, and flagged when the visible text names a different host). Only http, https and mailto are opened.
- Remote images blocked by a content rule list that blocks every http and https load, until the user taps "Show images" for that message (the rule list is removed for that view only). `data:` and `cid:` images load.
- No cookies or website data (non persistent data store).
- Sized to content (height reported from layout, no inner scrolling), honours light and dark by injecting colour scheme CSS and a transparent background.
- Plain text bodies render with native text controls, with detected links.

## 14. Accessibility

Every control has a label; list rows read "sender, subject, time, unread or read, flagged, N attachments"; contrast at least 4.5:1 for text using `text`, `text2`, `text3`; full keyboard operation; Dynamic Type or text scaling does not break rows (rows grow, compact density is the only fixed height).
