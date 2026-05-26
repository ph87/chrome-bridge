# ChromeBridge Security Review

Date: 2026-05-26

This document reviews the current ChromeBridge architecture after the UI migration from a page-injected sidebar to a Chrome side panel. It covers the extension, side panel UI, native host, local HTTP/IPC bridge, agent launch path, and bundled CLI.

## Scope

Reviewed components:

- `skills/chrome-bridge-setup/chrome-bridge-extension/manifest.json`
- `skills/chrome-bridge-setup/chrome-bridge-extension/background.js`
- `skills/chrome-bridge-setup/chrome-bridge-extension/sidepanel.js`
- `skills/chrome-bridge-setup/chrome-bridge-extension/commands/page.js`
- `skills/chrome-bridge-setup/native-host/app.js`
- `skills/chrome-bridge-setup/native-host/agents/index.js`
- `skills/chrome-bridge-setup/native-host/agents/adapters/stdioAdapter.js`
- `skills/chrome-bridge-setup/native-host/agents/adapters/acpRpcAdapter.js`
- `skills/chrome-bridge-setup/native-host/agents/utils.js`
- `skills/chrome-bridge-cli/scripts/_bridge_client.js`
- `skills/chrome-bridge-cli/scripts/chrome-bridge-cli.js`
- `README.md`

## Executive Summary

ChromeBridge is an intentionally powerful local-control tool. It combines:

- a Chrome extension with broad browser privileges
- a local native-messaging host
- an authenticated local HTTP or IPC command endpoint
- a side panel that can launch user-configured local agent commands
- a bridge that can execute JavaScript, inspect frames, capture screenshots, and close tabs

The migration from an injected page sidebar to a Chrome side panel materially improved the security posture. The highest-risk issue from the previous design, untrusted page DOM hosting privileged UI, is no longer the primary concern.

The remaining risk profile is now centered on privilege concentration rather than DOM isolation:

- the extension still has high-impact browser permissions
- the native host still exposes a powerful local control endpoint
- agent definitions can still launch arbitrary local commands
- tab context is still handed to the agent without a formal origin approval model
- authentication is still centered on a long-lived bearer token stored on disk and displayed in the UI

This is a better architecture than before, but it is still not a hardened security boundary between arbitrary web content and local automation.

## What Improved Since The Side Panel Migration

The following issues were materially reduced by moving the UI into `sidepanel.html` and `sidepanel.js`:

- Untrusted websites no longer host the privileged chat and settings UI in page DOM.
- Websites can no longer directly scrape the settings inputs from injected DOM.
- Websites can no longer dispatch synthetic DOM events directly against the privileged UI surface.
- Settings and agent configuration now live in an extension-owned page rather than in ordinary websites.

These are real improvements and should be considered the main architectural security win of the migration.

## Threat Model Assumptions

This review assumes:

- the user intentionally installed the extension and native host
- the local machine is not fully compromised already
- arbitrary websites may still be open in Chrome
- the side panel may be used while viewing untrusted pages
- local bearer tokens and local config files should not be treated as secret against the same OS user account

This tool is fundamentally designed to cross privilege boundaries on behalf of the user. The goal is therefore not "no powerful capability," but "powerful capability with explicit, narrow, and reviewable trust boundaries."

## High-Level Assessment

Current posture:

- Better UI isolation than the old injected-sidebar model
- Still a high-risk local automation tool
- Safe enough for careful power-user workflows
- Not yet appropriate to describe as a hardened secure bridge from arbitrary web content to local agents

Primary current concerns:

1. Arbitrary local command launch remains configurable from the side panel.
2. The local bridge endpoint remains highly capable if the token is disclosed.
3. Browser privileges are broad and concentrated in one extension.
4. Page context is still granted to the agent without strong origin approval or per-capability consent.

## Findings

### 1. Custom agent definitions allow arbitrary local command execution

Severity: High

Relevant code:

- `skills/chrome-bridge-setup/chrome-bridge-extension/sidepanel.js`
- `skills/chrome-bridge-setup/native-host/agents/index.js`
- `skills/chrome-bridge-setup/native-host/agents/utils.js`
- `skills/chrome-bridge-setup/native-host/agents/adapters/stdioAdapter.js`
- `skills/chrome-bridge-setup/native-host/agents/adapters/acpRpcAdapter.js`

Why it matters:

- The side panel lets the user define `command`, `args`, and `adapter`.
- The native host accepts the UI-provided spec and passes it directly into `spawn(...)`.
- `resolveExecutable()` only checks for a non-empty string; it does not enforce an allowlist, path policy, or signing policy.
- This makes ChromeBridge an arbitrary local process launcher, not merely a browser automation tool.

Security impact:

- Any compromise of extension UI state, extension code, or local config handling can become local command execution.
- Operator mistakes in agent configuration can silently expand the trust boundary.
- A more privileged or dangerous agent can be activated without any security review step.

Notes:

- This may be intentional for advanced users.
- Even if intentional, it should be documented as a privileged feature, not treated as a normal settings field.

Improvement suggestions:

- Introduce a trust split between built-in agents and custom commands.
- Require an explicit warning and confirmation flow before saving or activating custom commands.
- Add an allowlist mode for commands or executable directories.
- Consider signing or validating built-in agent manifests separately from ad hoc user commands.

### 2. The local bridge endpoint is powerful and protected only by a long-lived bearer token

Severity: High

Relevant code:

- `skills/chrome-bridge-setup/native-host/app.js`
- `skills/chrome-bridge-cli/scripts/_bridge_client.js`
- `skills/chrome-bridge-setup/chrome-bridge-extension/sidepanel.js`

Why it matters:

- The local host exposes `/command`, `/events`, and `/health`.
- `/command` can execute JavaScript in tabs, inspect frames, capture screenshots, and close tabs.
- Authentication is based on a reusable bearer token stored in `~/.chrome-bridge/config.json`.
- The same token is shown in the side panel settings and used by the CLI.

Security impact:

- If the token leaks, the local bridge can be driven directly without going through the extension UI.
- The token is long-lived until refreshed.
- HTTP mode on `127.0.0.1` is materially broader than IPC mode because more local callers can attempt to use it.

Important nuance:

- The side panel migration removed the old "page can read token from injected DOM" issue.
- The token is still a high-value credential, just no longer exposed through page DOM.

Improvement suggestions:

- Prefer IPC as the default transport.
- Avoid displaying the full token in the UI unless absolutely necessary.
- Consider replacing the long-lived bearer token with short-lived or per-session credentials.
- Consider binding CLI auth to a local OS-controlled channel rather than a reusable static token.
- Add clearer user-facing language that possession of the token is equivalent to bridge control.

### 3. Extension privileges remain broad, so any extension compromise has a large blast radius

Severity: High

Relevant code:

- `skills/chrome-bridge-setup/chrome-bridge-extension/manifest.json`
- `skills/chrome-bridge-setup/chrome-bridge-extension/background.js`

Observed permissions:

- `nativeMessaging`
- `scripting`
- `tabs`
- `activeTab`
- `debugger`
- `storage`
- `sidePanel`
- `host_permissions: ["<all_urls>"]`

Why it matters:

- `debugger` plus `scripting` plus `<all_urls>` gives the extension broad browser control.
- `nativeMessaging` connects that browser control to a local process boundary.
- The side panel is safer than page DOM, but the extension itself is still a high-trust component.

Security impact:

- Any future extension bug, supply-chain issue, or malicious local modification could have high consequence.
- The extension can inspect and act on arbitrary pages, frames, and tabs once it is driving the browser.

Improvement suggestions:

- Re-evaluate whether all declared permissions are strictly necessary.
- Re-evaluate whether `<all_urls>` is needed continuously or can be reduced.
- Document the intended permission model and why each permission exists.
- Consider isolating high-risk functions behind additional opt-in controls.

### 4. There is no formal origin approval model for page-context agent operations

Severity: Medium to High

Relevant code:

- `skills/chrome-bridge-setup/chrome-bridge-extension/background.js`
- `skills/chrome-bridge-setup/chrome-bridge-extension/commands/page.js`
- `skills/chrome-bridge-setup/chrome-bridge-extension/runtime-config.js`

Why it matters:

- `/page` and auto-context attach tab id, URL, and title to the prompt.
- The agent is then instructed to use ChromeBridge to inspect and act on that tab.
- This happens without a per-origin allowlist, approval prompt, or trust classification.

Security impact:

- A user can accidentally grant an agent authority over a hostile or sensitive tab with one message.
- Prompt injection from page content is still possible at the content layer even though the UI is now isolated.
- The agent may act on pages where the user did not intend to authorize automation beyond casual chat.

Improvement suggestions:

- Add per-origin approval before enabling `/page` context on a site.
- Show origin and trust state prominently in the chat UI.
- Support allowlist-only mode.
- Consider disabling auto-context by default or gating first-use per origin.

### 5. The side panel still exposes high-impact settings and the raw token in one place

Severity: Medium

Relevant code:

- `skills/chrome-bridge-setup/chrome-bridge-extension/sidepanel.js`

Why it matters:

- The side panel shows the full token.
- The same surface also edits transport mode, host endpoint, and executable command specs.
- The page-DOM attack path is gone, but the extension-owned UI still concentrates several sensitive controls together.

Security impact:

- Any extension-code compromise or extension-page XSS in the future would immediately expose multiple privileged values.
- Users may copy or mishandle the token because it is presented as a normal field.

Improvement suggestions:

- Mask the token by default and reveal it only on explicit action.
- Separate operational chat from advanced configuration more clearly.
- Add stronger warnings around transport changes and custom command editing.

### 6. Sensitive state is stored locally in plaintext and should be treated as same-user accessible

Severity: Medium

Relevant code:

- `skills/chrome-bridge-setup/native-host/app.js`
- `skills/chrome-bridge-cli/scripts/_bridge_client.js`
- `skills/chrome-bridge-setup/chrome-bridge-extension/sidepanel.js`

Why it matters:

- `~/.chrome-bridge/config.json` stores mode, endpoint, socket path, and token in plaintext.
- `chrome.storage.local` stores agent definitions and active selection.
- These are not protected against the same local OS user account.

Security impact:

- Local tools, shell sessions, or malware running as the same user may be able to read these values.
- The config file should be treated as a privileged local secret store, but it currently behaves like ordinary plaintext config.

Improvement suggestions:

- Document that the token is only protected at the OS-user boundary, not beyond it.
- Consider stricter file permissions on the config path.
- Consider whether full token persistence is necessary in the current design.

### 7. The bridge has coarse-grained authentication but no capability scoping

Severity: Medium

Relevant code:

- `skills/chrome-bridge-setup/native-host/app.js`
- `skills/chrome-bridge-cli/scripts/_bridge_client.js`

Why it matters:

- The bearer token unlocks all supported commands.
- There is no separate authorization layer for:
  - JavaScript execution
  - screenshot capture
  - tab closure
  - events access
  - future commands

Security impact:

- A leaked token grants a broad operational bundle rather than a narrow capability.
- It is hard to restrict callers to low-risk functions.

Improvement suggestions:

- Introduce capability tiers or command-level authorization.
- Consider separate tokens or approval flows for destructive or high-risk commands.
- Add a more explicit audit trail for who triggered what kind of action.

### 8. Browser execution features intentionally bypass strong page boundaries

Severity: Medium

Relevant code:

- `skills/chrome-bridge-setup/chrome-bridge-extension/background.js`

Why it matters:

- JavaScript evaluation is performed through `chrome.debugger`.
- The code sets `userGesture: true`.
- The code enables `allowUnsafeEvalBlockedByCSP: true`.
- Evaluation can target frames by id or partial URL pattern.

Security impact:

- This is powerful by design, but it means ChromeBridge can do more than ordinary page scripts.
- If misused, it can bypass assumptions that websites rely on, including CSP-related assumptions.

Improvement suggestions:

- Explicitly document that ChromeBridge executes at a higher privilege than page JavaScript.
- Consider adding stronger UI warnings or consent for the first use of high-impact browser actions.

### 9. Agent subprocesses inherit broad local context and have limited safety controls

Severity: Medium

Relevant code:

- `skills/chrome-bridge-setup/native-host/agents/adapters/stdioAdapter.js`
- `skills/chrome-bridge-setup/native-host/agents/adapters/acpRpcAdapter.js`

Why it matters:

- Agent subprocesses inherit `process.env`.
- ACP sessions default `cwd` to the project root.
- There are no sandbox, timeout, filesystem, or network restrictions applied to agent processes here.

Security impact:

- Agent behavior is bounded mainly by the agent program itself, not by ChromeBridge.
- If a configured agent is dangerous, the bridge provides few compensating controls.

Improvement suggestions:

- Treat agent choice as a security boundary decision.
- Consider optional process hardening or lower-privilege execution modes.
- Consider per-agent warnings or declared capability metadata.

## Threat Scenarios

### Scenario A: Token disclosure leads to direct bridge control

1. An attacker obtains the bearer token from local config, logs, screenshots, or a future extension bug.
2. The attacker sends requests to `/command` over HTTP or IPC.
3. The attacker executes JavaScript in tabs, captures screenshots, or closes tabs without using the side panel.

### Scenario B: Risky custom agent command turns ChromeBridge into a generic command launcher

1. A user configures a custom agent command in the side panel.
2. That command has broader local powers than expected.
3. A normal chat request reaches the native host.
4. The agent executes local operations far beyond simple browser assistance.

### Scenario C: Hostile page content manipulates the agent indirectly through `/page` context

1. The user chats while viewing an untrusted site.
2. Auto-context or `/page` binds the current tab to the agent request.
3. The page contains adversarial instructions or data designed to influence the agent.
4. The agent acts on hostile content with higher local and browser privileges than the website itself has.

### Scenario D: Extension compromise has high browser and local impact

1. A future extension bug or malicious modification affects the extension runtime.
2. The attacker gains access to extension-side messaging, storage, or UI state.
3. The attacker reaches both browser-control and native-host control surfaces.
4. The compromise spans tabs, local commands, and bridge credentials.

## Prioritized Hardening Recommendations

### Short Term

- Rewrite user-facing docs to describe ChromeBridge as a privileged local automation tool.
- Default new installs to IPC mode where feasible.
- Mask the token in the side panel by default.
- Add strong warnings and confirmations for custom agent command edits and activation.
- Show current page origin more prominently in the chat surface.

### Medium Term

- Add per-origin approval before enabling tab-context agent workflows.
- Add a built-in-vs-custom agent trust split.
- Add capability scoping or separate authorization for high-risk bridge commands.
- Reduce extension permissions where technically possible.
- Improve audit logging around command execution, token rotation, and agent launches.

### Long Term

- Replace the long-lived shared bearer token with a narrower auth model.
- Introduce stronger process isolation or reduced-privilege modes for agent subprocesses.
- Separate low-risk browser automation features from high-risk local-agent execution paths.
- Define and document a formal threat model for browser, extension, native host, and local process trust boundaries.

## Recommended Security Positioning

ChromeBridge should currently be positioned as:

- experimental
- powerful
- local-first
- appropriate for trusted-user workflows
- not yet a hardened security boundary against hostile sites or same-user local compromise

Recommended user guidance:

- Prefer IPC transport over HTTP when possible.
- Treat custom agent commands as privileged local execution.
- Be deliberate about using `/page` or auto-context on untrusted pages.
- Treat the local token and config as sensitive.
- Assume that anyone who can fully control your user account can likely control ChromeBridge too.

## Conclusion

The side panel migration fixed the most serious weakness in the old UI model: privileged controls no longer live in arbitrary page DOM. That was the correct architectural move.

The project is still high-trust software. The primary remaining challenge is not DOM isolation, but managing a deliberately powerful chain:

- browser privileges
- native host privileges
- local bridge credentials
- agent subprocess execution

The next maturity step should be explicit trust reduction: fewer always-on permissions, stronger origin approval, safer auth, and a more opinionated boundary around custom agent execution.

## Notes

This review is based on static inspection of the repository and reasoning about the current code paths. It did not include dynamic exploitation testing, malicious extension simulation, browser-level red-team testing, or local privilege escalation analysis beyond the documented trust assumptions.
