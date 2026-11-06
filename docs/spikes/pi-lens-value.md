# pi-lens value review

- Date: 2026-11-06
- Data: 202 Pi session files of the user (about 10,000 tool calls), read locally. No session content is stored here.
- Question: is pi-lens worth its memory cost for pi-spore agents? (ADR 0025)

## Direct tool use

pi-lens tools were 301 of 9,961 tool calls (3%). The most used: `read_symbol` (119), `lens_diagnostics` (88),
`module_report` (59). For comparison: `bash` 5,126, `read` 1,496, `edit` 877.

## Feedback after edits

| File type | Edits | Blocked by pi-lens | Block rate |
|---|---|---|---|
| `.cs` (Unity) | 496 | 146 | 29% |
| `.ts` | 270 | 10 | 4% |
| `.md` | 238 | 0 | 0% |
| `.json` | 66 | 0 | 0% |

C# block messages, by shape (one block can hold several):

| Message | Count |
|---|---|
| The type or namespace name ... could not be found | 826 |
| The name ... does not exist in the current context | 120 |
| The type or namespace name ... does not exist in the namespace ... | 35 |
| Argument ...: cannot convert from ... to ... | 32 |
| ... does not contain a definition for ... | 27 |

The names reported as missing were mostly the project's own gameplay types. A spot check of the six most frequent
ones found five in the project's source today, inside assemblies that the `.csproj` files include. Unity regenerates
`.csproj` files only when the editor refreshes, so types in new files are invisible to a language server until
then. Most C# blocks were therefore false alarms. A smaller share (conversion and overload errors) looked real.

TypeScript blocks were mostly real type errors.

## Conclusion

In Unity projects, pi-lens mostly adds noise. In TypeScript projects it catches some real errors early. Gates and
an on-demand `check` tool catch the same real errors with accurate tools, without 410 MB per agent.
