# Security / Authorization / Review UX Notes

## Current direction

The workspace now treats trusted roots and reviewer identity as first-class settings instead of hidden implementation details.

### Trusted roots

- `authorized` mode still runs inside sandbox rules by design.
- The default trust baseline now includes the workspace plus Desktop, because many users start from files on the Desktop before they move them into a project folder.
- Trusted roots are exposed in Work settings and are persisted through preferences instead of being implied by a single working directory.

### Authorization flow

- Command/code snippets now prefer `Copy` for shell blocks. `Apply` is only shown for real code blocks where applying code makes sense.
- Tool authorization cards support `allow once`, `allow this session`, and `always allow here`, which maps better to real user intent than a single binary approval.
- Generic destructive confirms now use the in-app confirmation surface instead of an Electron system message box, which removes the jarring native prompt mismatch and keeps keyboard/a11y behavior consistent.

### Review flow

- Review is no longer "pick any non-current agent".
- Chat review only routes to Hanako or Butter reviewers.
- Expert/channel agents are excluded from this path.
- Review cards show the reviewer persona and avatar so users can see who actually performed the review.
- Work settings bind dedicated Hanako / Butter reviewer agents.
- Each reviewer agent keeps its own `models.chat`, so Hanako, Butter, and Lynn can be configured against different models.

## Accessibility notes

- Confirmation and review surfaces keep explicit button labels instead of icon-only affordances.
- Review configuration buttons now expose labels and can deep-link to the exact reviewer agent configuration.
- The settings path explains where model configuration lives, reducing hidden state and lowering cognitive load.

## Remaining follow-up

- Add explicit renderer tests for the new in-app confirm request bridge.
- Add integration coverage for review UI rendering once the current React test surface grows around WebSocket review events.
- If we later add more reviewer personas, keep them out of chat review until they have a dedicated UX and model-binding story.
