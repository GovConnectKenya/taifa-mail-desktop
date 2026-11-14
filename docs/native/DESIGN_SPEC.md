# Taifa Mail native clients: design spec

Status: v1, shared by the macOS app (Swift, SwiftUI, AppKit) and the Windows app (WinUI 3 or equivalent native stack). Everything here is platform neutral unless a section says otherwise. The API behaviour is in `API_CONTRACT.md`.

Source of truth: the existing Taifa Mail design. The webmail (`webmail/src`, `frontend/src/lib/styles/tokens.css`, `frontend/src/lib/components`) is the primary reference and the native apps must be recognisably Taifa Mail. Spaci only informs the spacing rhythm and title bar detail where the webmail is silent. Tokens below are mapped one to one from `frontend/src/lib/styles/tokens.css` (names in the last column).

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

Fonts: Google Sans (Regular, Medium, SemiBold; 700 maps to SemiBold) for the UI and JetBrains Mono (Regular, Medium, SemiBold) for addresses, counts and ids. Both are SIL OFL 1.1 and ship in the webmail repo (`backend/app/templates/generated_documents/assets/fonts/*.ttf`; copyright 2025 The Google Sans Project Authors, 2020 The JetBrains Mono Project Authors); bundle the TTFs with the OFL text. No global tracking; headings only use -0.01em.

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `type.caption` | 11 / 16 | 500 | counts, timestamps in dense rows, badges |
| `type.meta` | 12 / 16 | 400 | snippet, header meta lines, sidebar secondary |
| `type.body` | 13 / 20 | 400 | list rows, sidebar rows, settings labels |
| `type.bodyStrong` | 13 / 20 | 600 | unread sender and subject, selected row title |
| `type.reader` | 14 / 22 | 400 | native plain text bodies |
| `type.title` | 16 / 22 | 600 | reader subject, section titles |
| `type.display` | 20 / 26 | 600 | sign-in title, empty state title |
| `type.hero` | 24 / 30 | 600 | sign-in wordmark line only |

Plain text bodies use `type.reader`; HTML bodies set a 14px base font through injected CSS so both look alike.

## 3. Brand, logo and colour tokens

Brand: the Kenyan flag colours as the Constitution specifies them: black `#000000`, green `#008C51` (brightened to `#1EA94E` on dark), red `#922529`. Ink on a green fill is always white, so solid green fills use `#00864E` (white ink at AA). Warnings are amber, never brand colours. Violet (`--color-ai`) is reserved for AI features and is not used in v1.

Logo: the real Taifa Mail logo, `webmail/static/logos/taifa_logo.svg` (green and black) on light surfaces and `taifa_logo_white.svg` on dark surfaces. Used in the sidebar header (24 high next to the "Taifa Mail" wordmark), the sign-in card (56 high), empty states (40 high), About. On macOS both files sit in one image set with a dark appearance variant. Never redraw or recolour it.

App icon: `taifa-mail-desktop/assets/branding/icon.png` (1024, dark body icon: the black M brand mark vanishes on a dark Dock, so the shipped icon has a dark body). Build the platform icon set from it. Do not use the black-on-transparent `icon-512.png`. Menu bar or tray: `trayTemplate.png` and `@2x`.

Colour tokens (light / dark, from `tokens.css`):

| Token | Light | Dark | CSS token |
|---|---|---|---|
| `bg` | `#F5F8F6` | `#101010` | `--color-bg` |
| `surface` (list, reader cards, compose) | `#FFFFFF` | `#161616` | `--color-surface` |
| `sidebar` | `#FFFFFF` | `#141414` | `--color-sidebar` |
| `surface2` (hover, inputs) | `#EDF3EF` | `#242424` | `--color-surface-2` |
| `surfaceSelected` | `#E3F0E8` | `#1D2E24` | `--color-surface-selected` |
| `border1` | `#DCE5DF` | `#2E2E2E` | `--color-border-1` |
| `border2` | `#C3D0C8` | `#3D3D3D` | `--color-border-2` |
| `borderSoft` (row separators) | `#E8EEEA` | `#222222` | `--color-border-soft` |
| `skeletonBase` / `skeletonSheen` | `#E6ECE8` / `#F4F7F5` | `#1A1A1A` / `#262626` | `--skeleton-*` |
| `text` | `#000000` | `#ECECEC` | `--color-text` |
| `muted` | `#52665E` | `#A8A8A8` | `--color-muted` |
| `mutedSoft` | `#5C6F67` | `#949494` | `--color-muted-soft` |
| `neutralDot` (decorative only) | `#8DA096` | `#8A8A8A` | `--color-neutral-dot` |
| `accent` (dot, ring) | `#008C51` | `#1EA94E` | `--color-accent` |
| `accentFill` (buttons, white ink) | `#00864E` | `#16803C` | `--color-accent-fill` |
| `accentFillHover` | `#007343` | `#1A8F44` | `--color-accent-fill-hover` |
| `accentSoft` (selected row) | `#E6F4EE` | `rgba(30,169,78,.14)` | `--color-accent-soft` |
| `accentInk` (accent text) | `#00643A` | `#8ADBAA` | `--color-accent-ink` |
| `danger` / `dangerInk` / `dangerSoft` | `#922529` / `#741D20` / `#F8E4E2` | `#FF7A5E` / `#FFA892` / `rgba(214,63,40,.18)` | `--color-danger*` |
| `warn` / `warnInk` / `warnSoft` | `#8A6400` / `#6B4E00` / `#FAF3D9` | `#E0B22E` / `#F0D27A` / `rgba(217,165,20,.14)` | `--color-warn*` |
| `info` / `infoSoft` | `#254DA8` / `#E5ECFB` | `#8FB0F5` / `rgba(122,163,243,.14)` | `--color-info*` |
| `shadowRaised` | `0 1 2 rgba(20,44,36,.08)` | `0 1 2 rgba(0,0,0,.4)` | `--shadow-raised` |
| `shadowOverlay` | `0 16 40 rgba(20,44,36,.16)` | `0 16 40 rgba(0,0,0,.48)` | `--shadow-overlay` |
| `ring` | `rgba(0,140,81,.16)` 4 | `rgba(30,169,78,.20)` 4 | `--ring` |

The page canvas is a faint tint; content surfaces are white and flat, separated by hairlines rather than shadows. Only overlays float.

## 4. Radii

`radius.xs` 4 (tags, badges), `radius.ctl` 8 (controls, inputs), `radius.card` 12 (thread rows, cards, message cards in the reader), `radius.panel` 16 (sheets, modals, sign-in card), `radius.pill` (chips, avatars, token chips). Same values as `--radius-*`. Institution logo tiles use `radius.ctl` scaled to the tile (25 percent of the side, minimum 6).

## 5. Selection and focus

Follows `webmail/src/mail/ThreadList.svelte` (flat ruled list, lines ~1515-1558):

- The thread list is a flat ruled list on the page ground (`bg`), shared with the reader. Rows have radius 0, padding-inline 20, padding-block 12 (8 in compact), a 1 px `borderSoft` bottom hairline, and content height (no fixed row height).
- Selected row: `accent` at 16 percent over `bg`, no border. Hover: `surface2`.
- Unread: an 8 px accent dot at the start of the subject line (no leading column), sender weight 700 (500 read), subject 600 (400 read), time bold in `accentInk`.
- Sidebar rows (36 px, radius 8): active is `accentSoft` fill with `accentInk` text 600, no border.
- Hover `surface2`, pressed `border1`, keyboard focus a 2 px accent ring with a 2 px gap (the list shows it around the whole list).
- Accent everywhere is Taifa green: the app's AccentColor is `#008C51` light and `#1EA94E` dark, so system controls (toggles, pickers, links, spinners) are never blue.

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

Column widths (macOS split view): sidebar 200 min, 240 ideal (webmail `--sidebar-w` is 256), 280 max; thread list 300 min, 360 ideal, 480 max; reader 420 min. Minimum window 900 x 600, default 1280 x 800.

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

Shapes at the same size: a person photo is a circle; an institution logo is a contained rounded tile (aspect fit inside the tile, `panel2` background, never cropped to a face); the placeholder follows `frontend/src/lib/components/Avatar.svelte`: a person silhouette in white on a deterministic colour when an address is known (the silhouette is the honest signal that this stands for a person), the letter only for things that are not people. Deterministic colour: FNV-1a 32 bit hash of the lowercased address modulo 8, into this palette (same in light and dark): `#006900 #7A4B00 #00555E #4A3B8F #8A2B55 #2F5D8A #5A6B00 #7B3F2A`. Image loads are cached on disk and in memory, decoded off the main thread, downsampled to 2x the display size.

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
- Sidebar is the webmail rail: brand row (32 px logo, "Taifa Mail" 16/600), a 48 px green Compose button (`accentFill`, white 13/600, raised shadow), folders (rows 36 px, gap 12, padding 12, radius 8; counts in JetBrains Mono 11, unread bold in `accentInk`, Drafts shows the total), folder order Inbox, Sent, Drafts, Archive, Junk, Quarantine, Trash then the rest alphabetically under a "Folders" label, a storage meter from GET /quota, and the account menu at the bottom. Scheduled, Snoozed and Labels are not in v1.
- Widths: sidebar 256 ideal, list 392 ideal, reader fills.
- Sidebar, thread list, reader. The sidebar is the webmail `sidebar` surface (flat, hairline separated) with the logo and wordmark at the top, as in the webmail; window chrome (traffic lights, toolbar, menu bar) stays native. On Windows the same with Mica behind the title bar and the sidebar as a NavigationView pane.
- Sidebar top: mailbox switcher (avatar 28, display name, address in `type.meta`, chevron down) when `GET /auth/mailbox/switchable` returns siblings, otherwise a static identity block. Then folders in fixed order Inbox, Drafts, Sent, Archive, Junk, Trash, then other folders under a "Folders" header. Counts: unseen only, `type.caption`, hidden at 0, `99+` cap. Drafts shows total instead of unseen.
- Special use icons: Inbox, Drafts, Sent, Archive, Junk, Trash from the Iconsax mail set; other folders get the folder icon.
- Loading: 6 skeleton sidebar rows, 8 skeleton thread rows (avatar disc, two bars), reader shows the empty "no selection" state.
- Empty list: icon, "Nothing here" title, one line hint ("This folder has no messages." or "No messages match your search.").
- Error: inline banner at the top of the list with "Retry"; cached rows stay visible if any.
- Offline: banner under the toolbar "Offline. Showing the last synced mail." (`warnSoft`); mutating actions are disabled with a tooltip "Not available offline".
- Signed out (session expired and refresh failed): the whole window swaps to 8.1 with a banner "Your session ended. Sign in again."

### 8.5 Thread list
- Header: folder name (16/600) with "total \u00b7 N unread" (11). While several rows are selected the header becomes a bulk bar (count, Archive, Delete, Mark read, Star).
- Row anatomy (webmail): avatar 36 (compact 32) at the top left; line 1 sender (13) and time (11, right); line 2 unread dot, subject (12), thread count (JetBrains Mono 10, end of line); line 3 preview (12, `muted`) with paperclip (13) and star (12, `warn`) at the end. Hover shows a pill of row actions (archive, delete, mark read or unread, star) at the top right.
- Compact density changes only padding and avatar size.
- Time format: today `HH:mm`, yesterday "Yesterday", this week the weekday, this year `d MMM`, older `d MMM yyyy`.
- Multi select: shift and command click. Infinite scroll with a footer spinner. Refresh: toolbar button and Shift+Cmd+K.
- Error (no cached rows): centred "Couldn't load {folder}", the message and a "Try again" outlined pill. Empty folder: "Nothing here" with "No messages match this view." (logo only on the truly empty Inbox). Loading: 8 skeleton rows.

### 8.6 Reader
- Flat thread on the page ground, no bordered cards. Toolbar of 32 px tools: Archive, Spam, Delete | Mark unread, Star, Move | spacer | "N of M" with Newer and Older chevrons.
- Subject 20/600, tracking -0.01em, padding 28. Each message separated by a `borderSoft` hairline; header with a 40 px avatar, name (13/600) and address (mono 11), date; body indented 52 under the sender. Collapsed messages are single rows (avatar 32, name, snippet, time) that expand on click. Long conversations show a dashed "Show earlier messages" pill (uses `has_more_older` and `next_before`).
- Sticky footer: 40 px outlined pill buttons Reply, Reply all, Forward (glyphs undo-arrow, reply-mail, forward).
- Opening a thread marks it read immediately and optimistically (rolls back on failure).
- Auth banner, remote image banner and attachment chips as before. Empty reader: a 64 px `accentSoft` circle with the mail glyph, "Select a conversation", "Choose a message from the list to read it here."
- Loading: skeleton header and body. Error: "Couldn't load this message" with "Try again". Offline uncached: "Not available offline".

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
| Undo (last action) | Option+Cmd+Z, or the Undo button of the toast (Cmd+Z stays text undo) | Ctrl+Z |

Note: the macOS bindings follow Mail.app (Cmd+R reply, Shift+Cmd+R reply all, Shift+Cmd+F forward, Cmd+F search), so refresh is Shift+Cmd+K and all-mail search is Option+Cmd+F. The Windows app follows Outlook (Ctrl+R, Ctrl+Shift+R, Ctrl+F forward, Ctrl+E search).

Undo: archive, delete, junk, move and flag changes can be undone while the toast "Moved to Trash. Undo" is visible (8 seconds) and through Cmd+Z, using the inverse call (`move` back to the source folder, `flags` inverse).

## 10. Platform conventions

macOS (14+): `NavigationSplitView` with three columns, unified toolbar (`.windowToolbarStyle(.unified)`), native traffic lights (spaci's x 18, y 22 inset applies if the title bar is hidden), full menu bar, Settings scene (Cmd+,), `UserNotifications` for new mail, Dock badge for the Inbox unread count, Quick Look for attachments, drag and drop for attachments, system accent is not used (brand green is the accent).

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

## 15. Notifications and badge

macOS `UserNotifications`, Windows toast. Permission is requested once the user is inside their mailbox, not at launch. A notification shows sender (title), subject, and a snippet, and activating it opens that thread. Decision rule (`NotificationPolicy`, unit tested): notify only for Inbox messages that are unread, were not sent by the owner, and were not already known to the app in this session; the first load of a session only records what exists. Settings has a toggle for notifications and one for the Dock (taskbar) badge, which shows the Inbox unread count. Notifications only arrive while the app runs (websocket plus 60 s REST reconcile).

## 16. Toasts

ToastPill: radius 8, 1 px `border1`, `surface`, min height 44, padding 12 by 20, weight 500, Undo in `accentInk` 600, a close button, `shadowOverlay`, bottom centre of the window 24 up, width min(420, available). Animated in and out (fade and rise), plain fade under Reduce Motion. The sign-in card follows `webmail/src/routes/login`: title "Sign in to Taifa Mail", subtitle "Sign in with your mailbox address and password to read and send mail.", 40 px controls.
