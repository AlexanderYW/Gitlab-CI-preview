// semantic-release configuration.
//
// Flow: conventional commits on `main` are analyzed to determine the next
// version → the version is bumped in both root and client package.json files →
// `scripts/package.sh` builds and packages the VSIX → a changelog is generated
// and committed → the VSIX is published to GitHub Releases, the VS Code
// Marketplace (vsce), and Open VSX (ovsx).
export default {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@google/semantic-release-replace-plugin",
      {
        replacements: [
          {
            files: ["packages/client/package.json"],
            from: /"version": "\d+\.\d+\.\d+"/g,
            to: '"version": "${nextRelease.version}"',
            countMatches: true,
          },
          {
            files: ["package.json"],
            from: /"version": "\d+\.\d+\.\d+"/g,
            to: '"version": "${nextRelease.version}"',
            countMatches: true,
          },
        ],
      },
    ],
    ["@semantic-release/exec", { prepareCmd: "bash scripts/package.sh" }],
    "@semantic-release/changelog",
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json", "packages/client/package.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]",
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: [{ path: "gitlab-ci-preview.vsix", label: "VSIX" }],
      },
    ],
    [
      "@semantic-release/exec",
      {
        publishCmd:
          "cd packages/client && bunx vsce publish --no-dependencies -i ../../gitlab-ci-preview.vsix && bunx ovsx publish -i ../../gitlab-ci-preview.vsix -p $OVSX_PAT",
      },
    ],
  ],
};
