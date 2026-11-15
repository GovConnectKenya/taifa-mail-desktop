# Platform logos

The real platform logos from SVGL (https://svgl.app), downloaded from the SVGL
API on 2026-11-15 and vendored byte for byte, unmodified. Copied unchanged from
the webmail (taifa-mail webmail/src/ui/platform-logos, used by its desktop
welcome modal) for the About window's platform badge. The webmail shows
them as image files: no path, colour or size is changed.

| File | Logo | SVGL API search | Downloaded from |
| --- | --- | --- | --- |
| `apple.svg` | Apple (light theme) | https://api.svgl.app?search=apple, entry 216 "Apple", `route.light` | https://svgl.app/library/apple.svg |
| `apple_dark.svg` | Apple (dark theme) | same entry, `route.dark` | https://svgl.app/library/apple_dark.svg |
| `windows.svg` | Windows (both themes; SVGL has one variant) | https://api.svgl.app?search=windows, entry 218 "Windows", `route` | https://svgl.app/library/windows.svg |
| `linux.svg` | Linux, Tux (both themes; SVGL has one variant) | https://api.svgl.app?search=linux, entry 358 "Linux", `route` | https://svgl.app/library/linux.svg |

## Licence note

SVGL is published under the MIT licence (`LICENSE-svgl`, from
https://github.com/pheralb/svgl at commit
90f6de7026c5e75a9014dbf1f422792bd40b1802). SVGL does not own the logos it
hosts: its README asks contributors to make sure they have the right to use
each SVG and that its licence permits adding it to SVGL. The marks remain the
property of their owners. Apple is a trademark of Apple Inc., Windows is a
trademark of the Microsoft group of companies, and Linux is the registered
trademark of Linus Torvalds (Tux was drawn by Larry Ewing with The GIMP). They
are used here only to name the system each desktop app download is for.
