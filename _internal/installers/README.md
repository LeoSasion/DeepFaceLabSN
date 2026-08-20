# Optional offline runtime archive

`启动 WebUI.bat` normally downloads a pinned Node.js LTS archive when no
compatible runtime is available. To make a bootstrap package work completely
offline, place this official archive in this directory before packaging:

```text
node-v24.19.0-win-x64.zip
```

- Official download: <https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip>
- SHA-256: `57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73`

The ZIP itself is intentionally ignored by Git. The bootstrap verifies the
checksum before extracting it to `_internal/node/bin` and never installs Node.js
system-wide.
