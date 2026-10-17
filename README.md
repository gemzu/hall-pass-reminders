# Hall Pass reminders

Sends Hall Pass reminders as notifications, every 15 minutes, from GitHub Actions:

- a class about 10 minutes before it starts
- work due tomorrow, at 8 PM the evening before
- work due within the hour

Devices turn reminders on in the app (Account, Reminders). On iPhone that has to be done in the Home Screen app.

## Secrets (repo Settings, Secrets and variables, Actions)

| Name | What |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | The JSON from Firebase console, Project settings, Service accounts, Generate new private key |
| `VAPID_PUBLIC_KEY` | Public half of the push key pair (also in the app) |
| `VAPID_PRIVATE_KEY` | Private half. Never commit it |

## Test locally

`DRY_RUN=1 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node send.mjs` prints what would be sent against the emulator.
