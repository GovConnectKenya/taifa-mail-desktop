# Keyboard

The desktop app's own shortcuts, from its menu bar (src/menu.js). The webmail's
single-key shortcuts (j, k, e, #, g i and the rest) work as they do on the web
and are listed in Help > Keyboard Shortcuts. On Windows and Linux, read Ctrl for
Cmd, and Alt for Opt.

## Find: Cmd+F follows what is on screen

| Keys | What it does |
| --- | --- |
| Cmd+F | Find in the open message, when a message is open and no composer or dialog is in front of it. Otherwise, Search Mail. |
| Opt+Cmd+F | Search Mail, always. |
| Cmd+G / Shift+Cmd+G | Next / previous match (Windows and Linux also F3 / Shift+F3). With the find bar closed, opens it again with the last text. |
| Return / Shift+Return | Next / previous match, in the find bar. |
| Escape | Closes the find bar and puts focus back in the message. |

Why context aware rather than keeping Cmd+F on Search Mail: in a mail client the
thing on screen is a message, and "find" means find in it. That is Apple Mail's
model (Cmd+F finds in the message, Opt+Cmd+F searches the mailbox) and the one a
browser user already has from Cmd+F on a web page. Search is never more than one
modifier away, and with no message open Cmd+F still searches, so it is never
dead. The menu shows Cmd+F against whichever item it will run at that moment,
so Edit > Find always says what the key will do.

Find in Message searches only the open conversation: the message list and the
folder rail are left out of the search (src/find.js explains how), and HTML
message bodies are searched too.

## Mail

| Keys | What it does |
| --- | --- |
| Cmd+N | New message |
| Shift+Cmd+N | New window |
| Cmd+O | Open the conversation in its own window (reader only, with Reply, Reply All and Forward) |
| Cmd+P | Print the whole conversation |
| Cmd+R / Shift+Cmd+R / Shift+Cmd+F | Reply / Reply All / Forward |
| Ctrl+Cmd+A (Windows, Linux: Ctrl+Shift+E) | Archive |
| Cmd+Delete (macOS) | Move to Trash |
| Shift+Cmd+J | Report spam |
| Shift+Cmd+U | Mark as read / unread |
| Shift+Cmd+L | Star / remove star |
| Cmd+1 to Cmd+5 | Inbox, Sent, Drafts, Archive, Trash (pressed in quick succession, the last one wins) |
| Opt+Cmd+N (Windows, Linux: F5) | Refresh |
| Ctrl+Cmd+S (Windows, Linux: Ctrl+Shift+S) | Show or hide the sidebar |
| Cmd+0 / Cmd+= / Cmd+- | Actual size / zoom in / zoom out |
| Cmd+, | Settings |
| Cmd+/ | Keyboard shortcuts |
| Cmd+W | Close the window (the main window hides; mail keeps arriving) |
