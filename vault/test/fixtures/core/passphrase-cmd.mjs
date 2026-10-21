// Fixture for the OPENCONTEXT_VAULT_PASSPHRASE_CMD tests: prints a fixed passphrase and ignores its arguments.
// If the vault ever ran the command through a shell, "; echo pwned" would append a second line — the test checks it does not.
process.stdout.write('fixture-pass-phrase\n');
