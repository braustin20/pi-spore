# The MCP token: make it on the desktop, deliver it to Unraid

Part of [runbook.md](runbook.md), steps S1 and S2. Card Hermes 1.4,
[ADR 0202](../../decisions/0202-hermes-remote-teammate.md) §8. This is the reverse direction of card Hermes 0.4
([hermes-pi-spore-profile.md](../../spikes/hermes-pi-spore-profile.md), "Key move to the desktop"): there the key
travelled Unraid → desktop, here the MCP token travels desktop → Unraid.

Nothing here is applied. Making the token and writing Unraid's `.env` are live steps: **each needs the user's
explicit yes**. See [runbook.md](runbook.md).

## Rules for the whole procedure

- The token is printed **nowhere**: not to a terminal, not into a log, transcript, chat answer, artifact, or commit.
  Every command below reads or writes a file, never an argument that holds the secret.
- It is never in `argv`, never in a prompt, and never in `settings.json`. `hermes.keyFile` and pi-spore's settings
  hold paths, never values.
- The token is narrow: it only calls the four `pi_spore` MCP tools. It is **not** pi-spore's user token
  (`~/.pi-spore/token`) and **not** the Hermes API key (`~/.pi-spore/hermes/pi-spore.key`). Keep the three apart: a
  leak of this one costs a stranger nothing but a refused request, because every request still needs the user's
  Accept on Home.
- Only two things may leave the desktop: the base64 of the RSA-OAEP ciphertext, and the SHA-256 of that ciphertext.
  Both are one-shot and safe to paste in chat. Ciphertext for the *other* direction's key must never be reused.
- No SSH, on the user's decision of 2026-11-25. Homelab Maintainer runs the Unraid side inside the Hermes container
  and reports back; the human pastes the two texts between the two sides.

## S1, desktop: make the token

The listener reads its own token file at call time, so the file must exist before the listener will serve anything.
From the merged loader (`modules/hermes/src/key.ts`): the folder must be `0700` or narrower, the file `0600` or
narrower, and the content non-empty printable ASCII (no spaces, no other bytes; surrounding whitespace is trimmed).
`openssl rand -hex 32` fits: 64 hex characters.

```bash
umask 077
mkdir -p ~/.pi-spore/hermes
chmod 700 ~/.pi-spore/hermes
openssl rand -hex 32 > ~/.pi-spore/hermes/mcp.token
chmod 600 ~/.pi-spore/hermes/mcp.token
ls -ln ~/.pi-spore/hermes/mcp.token          # -rw------- (0600), 64 bytes
ls -lnd ~/.pi-spore/hermes                   # drwx------ (0700)
```

Nothing above echoes the value. Do not add `cat`, and do not "check" the file by printing it: `ls -ln` and byte count
are the whole check. If pi-spore reports `503 mcp_token_unusable`, or its log says the listener could not read its
token, the file or its folder mode is wrong — the error names the path only, never the content.

Keep the file. It is the source for every later rotation, and the listener needs it to stay.

## S2, Unraid: a receiving key pair, then the token

Homelab Maintainer makes the pair on Unraid and relays **only the public key**. Do not reuse the desktop's card
Hermes 0.4 pair (`~/.pi-spore/hermes/transfer/receive.key`): that private key is on the wrong machine for this
direction.

The transfer folder below is `/opt/data/pi-spore-bridge/transfer` — the profile's own terminal working directory
(`terminal.cwd`), which the profile already uses for bridge files
([hermes-pi-spore-profile.md](../../spikes/hermes-pi-spore-profile.md)). The folder name is the operator's choice;
anywhere inside `/opt/data` that is not a Hermes home works.

### 2a. Unraid makes the pair

```bash
docker exec <container> sh -c 'umask 077; mkdir -p /opt/data/pi-spore-bridge/transfer &&
  cd /opt/data/pi-spore-bridge/transfer &&
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out receive.key &&
  openssl pkey -in receive.key -pubout -out receive.pub &&
  ls -ln'
docker exec <container> base64 -w0 /opt/data/pi-spore-bridge/transfer/receive.pub
```

The base64 public key is the only thing that comes off Unraid. It is not a secret.

### 2b. Desktop encrypts for that key

```bash
umask 077
mkdir -p ~/.pi-spore/hermes/transfer
base64 -d > ~/.pi-spore/hermes/transfer/unraid-receive.pub <<'EOF'
<the base64 public key from 2a; it decodes to the PEM file itself>
EOF
openssl pkeyutl -encrypt -pubin -inkey ~/.pi-spore/hermes/transfer/unraid-receive.pub \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 \
  -in ~/.pi-spore/hermes/mcp.token \
  -out ~/.pi-spore/hermes/transfer/mcp.token.enc
base64 -w0 ~/.pi-spore/hermes/transfer/mcp.token.enc      # text 1, for Unraid
sha256sum ~/.pi-spore/hermes/transfer/mcp.token.enc       # text 2, for Unraid
```

Step 2a sent `base64 -w0 receive.pub`, and `receive.pub` is PEM text, so the decode above recreates that file. If
`-pubin` complains, check the file starts with `-----BEGIN PUBLIC KEY-----` and has no stray spaces from the paste.

RSA-OAEP with SHA-256 and MGF1-SHA-256, the same scheme card Hermes 0.4 used, so both sides have a known-good recipe.
Send **both texts** as chat text, never as an attachment. Nothing else leaves the desktop: the private half of the
Unraid pair never left Unraid, and this ciphertext is one-shot for that one public key.

### 2c. Unraid checks the hash, then writes the token

Open a shell in the container once and run the rest there, so no long quoted command and no nested heredoc:

```bash
docker exec -it <container> sh
umask 077
cd /opt/data/pi-spore-bridge/transfer
base64 -d > mcp.token.enc <<'EOF'
<text 1, the base64 ciphertext>
EOF
sha256sum mcp.token.enc
```

Compare that hash with text 2 **before** decrypting. A mismatch means a bad paste: delete `mcp.token.enc`, ask for
texts 1 and 2 again. Do not retry a decrypt on a mismatched file.

Still in that shell, write it into the profile's `.env`. No value is ever an argument or a screen output: the `printf`
format string is the only literal, and the token arrives by file redirect.

```bash
openssl pkeyutl -decrypt -inkey receive.key \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 \
  -in mcp.token.enc -out mcp.token
tr -d '\n' < mcp.token > mcp.token.flat
sed -i '/^PI_SPORE_MCP_TOKEN=/d' /opt/data/profiles/pi-spore/.env
{ printf 'PI_SPORE_MCP_TOKEN='; cat mcp.token.flat; printf '\n'; } >> /opt/data/profiles/pi-spore/.env
```

Then the checks that do not print it, and the cleanup, still in that shell:

```bash
ls -ln /opt/data/profiles/pi-spore/.env
grep -c '^PI_SPORE_MCP_TOKEN=' /opt/data/profiles/pi-spore/.env     # 1
awk -F= '/^PI_SPORE_MCP_TOKEN=/{print length($2)}' /opt/data/profiles/pi-spore/.env   # 64
rm -f mcp.token mcp.token.flat mcp.token.enc
exit
```

- `.env` keeps the owner and mode it had before the edit — the same rule the spike used for `API_SERVER_KEY`.
- One `PI_SPORE_MCP_TOKEN=` line only, in **this profile's** `.env`, not in the shared `<hermes-data>/.env`: an entry
  in the wrong file reaches other profiles. Check with
  `docker exec <container> grep -l "^PI_SPORE_MCP_TOKEN=" /opt/data/profiles/*/.env /opt/data/.env` and expect only
  `profiles/pi-spore/.env`.
- Keep `receive.key`, `receive.pub`, and the desktop's `transfer/` files until step S6's evidence run proves the
  connection, then delete them:
  `docker exec <container> rm -f /opt/data/pi-spore-bridge/transfer/receive.key /opt/data/pi-spore-bridge/transfer/receive.pub`
  (use `shred -u` instead of `rm -f` if the image has it — check before applying). On the desktop:
  `rm -rf ~/.pi-spore/hermes/transfer`.
- **Check before applying:** whether a `.env` change is picked up on the next MCP connect or needs a gateway restart.
  The safe move is `docker exec <container> hermes gateway restart`, which the spike used for an `API_SERVER_KEY`
  change.

The desktop's own file stays where it is: the listener reads `~/.pi-spore/hermes/mcp.token` on every request.

## Rotation

Make a new token (S1), deliver it (S2 — `sed -i` drops the old line first), restart the gateway, then close the old
one: turn `hermes.mcp.enabled` off, back on, and confirm the four tools work again. Nothing invalidates the old value
except the file itself, so do not leave a second `.env` line behind.
