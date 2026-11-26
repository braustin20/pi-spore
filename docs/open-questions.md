# Open Questions

Each question names where it is used. Settle a question by writing or updating an ADR, then delete it here.

## Hermes

- **Q19. How far the `pi-spore` profile reaches in the Hermes container.** The profile's terminal uses the `local`
  backend. It is not a sandbox: it can reach other files in the container beyond `/opt/data/pi-spore-bridge`
  ([hermes-pi-spore-profile.md](spikes/hermes-pi-spore-profile.md)). Hermes asks for approval only for commands it
  flags as dangerous, so a plain file read may run with no approval. Whether to accept this reach, or narrow it on the Hermes side (another terminal backend,
  file permissions), is open. Only the user and the operator can change Hermes; pi-spore does not. (ADR 0202;
  `ask_hermes`, card Hermes 1.2; acceptance, card Hermes 1.5)
