'use strict';

// Help > Send Test Notification: what the sheet says, in plain words. The
// diagnostics (the OS error text, the page's permission, the log path) go to
// notifications.log, never into the sheet. Round 2's sheet was titled "sent"
// while reading "failed: ... (UNErrorDomain error 1.)" plus a log path.
//
// in: { platform, outcome: 'shown' | 'failed' | 'timeout', osStatus, pagePref }
// out: { message, detail, buttons, actions } where actions[i] is what button i
// does: 'os-settings' | 'app-settings' | null. Pure.

function osPlace(platform) {
  if (platform === 'darwin') return { where: 'System Settings > Notifications > Taifa Mail', button: 'Open System Settings' };
  if (platform === 'win32') return { where: 'Settings > System > Notifications', button: 'Open Notification Settings' };
  return { where: 'your desktop’s notification settings', button: 'Show Me How' };
}

function testNotificationReport({ platform, outcome, osStatus, pagePref }) {
  const os = osPlace(platform);
  if (outcome === 'failed' || osStatus === 'blocked') {
    return {
      message: 'Notifications are turned off for Taifa Mail',
      detail: `You won’t get new-mail alerts until notifications are allowed for Taifa Mail in ${os.where}.`,
      buttons: [os.button, 'Not Now'],
      actions: ['os-settings', null],
    };
  }
  if (pagePref === 'off') {
    return {
      message: 'New-mail alerts are off in Taifa Mail',
      detail: 'Your system shows notifications from Taifa Mail, but new-mail alerts are switched off in Taifa Mail’s settings.',
      buttons: ['Open Settings', 'Not Now'],
      actions: ['app-settings', null],
    };
  }
  return {
    message: 'Test notification sent',
    detail: `It should appear on your screen now. If it didn’t, check that notifications are allowed for Taifa Mail in ${os.where}.`,
    buttons: ['OK', os.button],
    actions: [null, 'os-settings'],
  };
}

module.exports = { testNotificationReport };
