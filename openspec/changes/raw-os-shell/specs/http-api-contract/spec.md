## MODIFIED Requirements

### Requirement: All live state arrives as a Contract-1 event

The contract SHALL state the rule that everything live arrives as an event-envelope (Contract-1) event over the cable, and that there SHALL be no bespoke cable message types. The ActionCable mount SHALL be `/~cable`, and the contract SHALL define the per-session subscription shape.

There SHALL be exactly one sanctioned exception to the "everything live is a Contract-1 event" principle: the raw interactive-shell byte stream (capability `raw-os-shell`). That stream is NOT an event envelope and SHALL NOT ride the `/~cable` mount; it uses a dedicated WebSocket transport reverse-proxied through the single published `rails` port (off the cable), and the shell host remains unpublished. The cable rule above is otherwise unchanged — the cable itself SHALL continue to carry only Contract-1 envelopes and no bespoke cable message types. This exception SHALL be recorded in `docs/contracts/CHANGELOG.md`; any transport carrying live state other than this documented shell-stream exception SHALL be a Contract-1 event on the cable.

#### Scenario: No bespoke cable messages

- **WHEN** any live update is broadcast to subscribers
- **THEN** it is delivered as a Contract-1 event envelope and not as a custom cable message shape

#### Scenario: Cable mounts at /~cable

- **WHEN** a client opens the realtime connection
- **THEN** it connects at `/~cable` and subscribes to the session channel

#### Scenario: The raw shell stream is the only off-cable live transport

- **WHEN** the `raw-os-shell` interactive shell streams stdin/stdout to a browser
- **THEN** it flows over its dedicated non-cable WebSocket (proxied through `rails`) and NOT as a Contract-1 event on `/~cable`, and this is the single documented exception recorded in `docs/contracts/CHANGELOG.md`

#### Scenario: The cable stays pure even when the shell exception is in use

- **WHEN** the shell feature is enabled and streaming
- **THEN** the `/~cable` mount still delivers only Contract-1 event envelopes with no bespoke cable message type introduced on the cable
