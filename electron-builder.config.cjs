const fs = require('node:fs');

// A PyInstaller bridge executable is preferred when the release workflow built
// one. Local development builds still work: the app falls back to a system
// Python 3 installation.
const extraResources = [
  { from: 'stratos_bridge.py', to: 'bridge/stratos_bridge.py' },
  { from: 'bridge_logbook_addon.py', to: 'bridge/bridge_logbook_addon.py' },
  { from: 'app', to: 'bridge/app' },
];

if (fs.existsSync('bridge-dist/stratos-bridge.exe')) {
  extraResources.push({ from: 'bridge-dist/stratos-bridge.exe', to: 'bridge/stratos-bridge.exe' });
}
if (fs.existsSync('bridge-dist/stratos-bridge')) {
  extraResources.push({ from: 'bridge-dist/stratos-bridge', to: 'bridge/stratos-bridge' });
}

module.exports = {
  appId: 'com.stratos.aviationmap',
  productName: 'Stratos',
  directories: {
    output: 'dist',
  },
  // Where the packaged app-update.yml points. This is what electron-updater
  // reads: the latest published release, including its latest.yml manifest.
  // The workflow still does the upload itself, so building never publishes.
  publish: [
    { provider: 'github', owner: 'Nyclyy', repo: 'stratos-tracker', releaseType: 'release' },
  ],
  files: [
    'electron-main.cjs',
    'electron-preload.cjs',
    'app/**/*',
    '!app/sw.js',
    '!app/**/*.map',
  ],
  extraResources,
  asar: true,
  compression: 'normal',
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'Stratos-Setup.exe',
    icon: 'app/icon-512.png',
  },
  // macOS: a DMG for people installing by hand and a ZIP for electron-updater,
  // which swaps the app bundle in place. The architecture is chosen on the
  // command line (--arm64 or --x64) so each runner builds only its own binary.
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.travel',
    icon: 'app/icon-512.png',
    artifactName: 'Stratos-${version}-mac-${arch}.${ext}',
    hardenedRuntime: true,
  },
  // Linux: a self-updating AppImage. electron-updater replaces the file it was
  // launched from, so only the AppImage target is needed.
  linux: {
    target: ['AppImage'],
    category: 'Utility',
    icon: 'app/icon-512.png',
    artifactName: 'Stratos-${version}-linux-x64.${ext}',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Stratos',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
  },
};
