/** @type {import('electron-builder').Configuration} */
const [repoOwner = 'McFuzzySquirrel', repoName = 'knowledge-dungeon'] = (
  process.env.GITHUB_REPOSITORY ?? ''
)
  .split('/')
  .filter(Boolean);
const linuxMaintainer =
  process.env.ELECTRON_BUILDER_LINUX_MAINTAINER ??
  'Knowledge Dungeon Maintainers <maintainers@example.invalid>';

const config = {
  appId: 'com.knowledgedungeon.app',
  productName: 'Knowledge Dungeon',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  asar: true,
  compression: 'maximum',
  files: ['dist/**', 'dist-electron/**', 'package.json'],
  extraMetadata: {
    main: 'dist-electron/main.js',
  },
  mac: {
    category: 'public.app-category.education',
    hardenedRuntime: true,
    target: ['dmg', 'zip'],
  },
  win: {
    target: ['nsis', 'zip'],
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Education',
    maintainer: linuxMaintainer,
  },
  publish: [
    {
      provider: 'github',
      owner: repoOwner,
      repo: repoName,
    },
  ],
};

export default config;
