/**
 * Dedicated packaging for 謠诼, including its built-in local archive worker.
 * Browser and desktop entries share the same database snapshot/reading engine.
 * Upstream WeFlow attribution and license remain in the packaged documents;
 * legacy WeFlow native helpers are not part of this engine.
 */
module.exports = {
  extends: null,
  appId: 'local.yaozhuo.caseboard',
  productName: '謠诼',
  extraMetadata: { main: 'dist-caseboard-electron/main.js' },
  directories: {
    output: 'release-caseboard',
    buildResources: 'public/caseboard',
  },
  files: [
    'caseboard-dist/**/*',
    'dist-caseboard-electron/**/*',
    'package.json',
    'LICENSE',
    'README-WeFlow.md',
  ],
  asar: true,
  asarUnpack: ['dist-caseboard-electron/native-worker.js'],
  npmRebuild: false,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  publish: null,
  win: {
    extraResources: [{ from: 'resources/caseboard/key-reader/win32', to: 'key-reader', filter: ['*.exe'] }],
    icon: 'public/caseboard/icon.png',
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
  },
  nsis: {
    unicode: true,
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    buildUniversalInstaller: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '謠诼',
  },
  mac: {
    extraFiles: [{ from: 'resources/caseboard/key-reader/darwin/yaozhuo-key-reader', to: 'Helpers/yaozhuo-key-reader' }],
    icon: 'public/caseboard/icon.png',
    category: 'public.app-category.productivity',
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
  },
  dmg: { title: '${productName} ${version}' },
}
