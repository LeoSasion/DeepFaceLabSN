# Launcher update-channel signing

`launcher/update-channel.json` currently belongs to the legacy `0.2.x`
channel. SHA-256 still protects downloads, but an independent Ed25519
signature becomes mandatory at `0.3.0` according to
`update-signing-policy.json`.

This first phase protects the release pipeline. The .NET Framework launcher
does not yet contain a hand-written cryptographic implementation; do not claim
that legacy clients verify the signature at runtime.

## Provision the real release key

Generate the Ed25519 key in the maintainer's password manager, HSM, or other
approved release-key store. Never generate or commit a placeholder production
private key. Commit only the SPKI public-key bytes and key ID under
`trustedKeys` in `update-signing-policy.json`.

The signing command prints both values after using the real private key:

```powershell
_internal\node\bin\node.exe tools\update-channel-signature.mjs sign `
  --manifest launcher\update-channel.json `
  --private-key C:\secure\dflsn-release-ed25519.pem
```

After adding the printed public key to the policy, verify it independently:

```powershell
_internal\node\bin\node.exe tools\update-channel-signature.mjs verify-policy
```

`tools/verify-release.ps1` refuses an unsigned `0.3.0+` channel, an unknown
key ID, an invalid signature, or a changed signed field. CI also runs an
ephemeral-key self-test and tamper-rejection tests. The private key is never
written to repository files, logs, command output, or GitHub Actions.
