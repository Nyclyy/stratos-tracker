/* The one version number the web app reports.

   The desktop build takes its version from package.json (electron-builder writes
   it into the installer and app.getVersion() returns it); the simulator bridge
   and this constant are stamped from the release tag by
   scripts/stamp-version.py. Settings, the About card and the update checker all
   read it from here so no screen can claim a different build. */

export const APP_VERSION = '2.1.19';

/** A version string with no build metadata, for display next to the wordmark. */
export function displayVersion(version = APP_VERSION) {
  return `v${String(version).replace(/^v/i, '')}`;
}
