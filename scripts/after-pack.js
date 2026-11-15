'use strict';

// electron-builder afterPack hook: flip Electron's fuses in the packaged app.
//
// afterPack runs after the app is assembled and BEFORE electron-builder signs
// it, so the signature covers the flipped binary. (electron-builder 24 has no
// built-in electronFuses option; that arrived in 25.)
//
// What each fuse closes:
//   RunAsNode off: ELECTRON_RUN_AS_NODE=1 can no longer turn the signed app
//     into a general Node interpreter that inherits its identity.
//   EnableNodeOptionsEnvironmentVariable off: NODE_OPTIONS cannot inject code.
//   EnableNodeCliInspectArguments off: --inspect / --inspect-brk are ignored,
//     so another local process cannot launch the app under a debugger and read
//     the mail session out of the main process.
//   EnableEmbeddedAsarIntegrityValidation on (macOS only): the app refuses an
//     app.asar whose hash does not match the one sealed into the signed
//     Info.plist (ElectronAsarIntegrity, written by electron-builder). Not on
//     Windows: electron-builder 24 does not embed the integrity resource in the
//     .exe, and with the fuse on and no resource the app would not start.
//   OnlyLoadAppFromAsar on: only app.asar is loaded, never a loose app/ folder
//     dropped next to it.
//   GrantFileProtocolExtraPrivileges off: file:// pages get ordinary browser
//     privileges. This also removes file:// reads from inside app.asar, so our
//     own pages (offline, tray popover) load through the taifa-ui:// scheme
//     (src/ui-scheme.js), never file://: loadFile() fails with
//     ERR_FILE_NOT_FOUND once this fuse is off.
//   LoadBrowserProcessSpecificV8Snapshot: left at Electron's default (off).
//
//   EnableCookieEncryption on: cookie values are encrypted at rest with a key
//     in the macOS Keychain ("Taifa Mail Safe Storage") or DPAPI on Windows.
//     Tested as an upgrade of an existing profile (0.2.0 without the fuse,
//     then with it): the existing plaintext cookies stay readable, so the
//     signed-in session carries over; cookies written afterwards are stored
//     encrypted and read back on the next launch. Chromium migrates lazily, so
//     there is no one-time rewrite. One-way: a build without the fuse cannot
//     read cookies written with it (RELEASING.md, rollbacks).

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const name = context.packager.appInfo.productFilename;
  let target;
  if (platform === 'darwin' || platform === 'mas') target = path.join(context.appOutDir, `${name}.app`);
  else if (platform === 'win32') target = path.join(context.appOutDir, `${name}.exe`);
  else target = path.join(context.appOutDir, context.packager.executableName);

  await flipFuses(target, {
    version: FuseVersion.V1,
    // The binary changes, so its ad-hoc signature must be redone on Apple
    // Silicon even for unsigned builds; a real signature replaces it later.
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === 'darwin',
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
  console.log(`  • fuses flipped    ${path.basename(target)} (${platform})`);
};
