## ADDED Requirements

### Requirement: Join flow exchanges an invite for the clawd_uid cookie and routes into the session

The landing/join screen SHALL accept an invite token and a display name, POST them to `POST /api/participants`,
and on success route into the session route. The server sets the signed httpOnly `clawd_uid` cookie; the client
SHALL NOT attempt to read the cookie (it is httpOnly) and SHALL track joined-state from the successful response
and the returned participant. This is the flow that mints the cookie authenticating both REST and the cable
connection.

#### Scenario: Successful join sets the cookie and enters the session

- **WHEN** a user submits a valid invite token and display name
- **THEN** the client POSTs `/api/participants`, the server sets the `clawd_uid` cookie, and the app routes to
  the session route with the returned participant in hand

#### Scenario: Failed join surfaces an error and does not enter the session

- **WHEN** the join request is refused (e.g. `404` invalid/expired/revoked token, `422` blank name)
- **THEN** the client shows the `{ errors }` message and does not route into the session

#### Scenario: Client never reads the httpOnly cookie

- **WHEN** the app needs to know whether the user is joined
- **THEN** it derives that from the join response / returned participant, not by reading `clawd_uid` (httpOnly)
