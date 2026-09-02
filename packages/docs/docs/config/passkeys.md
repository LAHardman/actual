# Authenticating with Passkeys

:::info
This feature requires use of [Actual Server](./index.md).
:::

:::caution
Passkey support is in preview. The server side described on this page is in place; the sign-in screen and the settings for managing passkeys are being added to the client in a following release. Until then, keep the server password available so you can always sign in.
:::

A passkey lets you sign in with your fingerprint, your face, or a security key instead of a password. Each passkey is a private key that never leaves your device, so there is nothing to phish and nothing to reuse across sites.

Enabling passkeys on your server also unlocks [multi-user support](./multi-user.md): every person who signs in with a passkey is a named user with their own role and their own access to budget files. Unlike [OpenID](./oauth-auth.md), passkeys need no identity provider. The sync server handles everything itself.

## How It Works

- The **first** passkey is created behind the server password. Whoever creates it becomes the server owner and an admin, exactly as the first OpenID login does today.
- Everyone else joins through an **enrolment link**. An admin creates the person in the User Directory, generates a link for them, and they open it on the device they want to sign in from. The link works once and expires after a day.
- Signing in shows a single **Sign in with a passkey** button. There is no username field: the device presents its own list of accounts for this server.
- A person can add a passkey for each device they use, and rename or remove them from settings. You cannot remove your own last passkey while passkeys are the active login method, so you cannot lock yourself out by tidying up. An admin can remove another person's last passkey so a lost phone can be replaced by a fresh enrolment link.

## Enabling Passkeys

Passkeys are bound to the address of your server, so the server has to know its own public URL. That URL must use `https://`, unless it is `localhost`, because browsers only allow passkeys in a secure context.

Set the following environment variables and restart the server:

- `ACTUAL_PASSKEY_SERVER_HOSTNAME`: the public URL of your server, for example `https://budget.example.com`. Its hostname becomes the relying party ID that every passkey is bound to.
- `ACTUAL_PASSKEY_RP_NAME`: the name your device shows when it asks you to create a passkey. Defaults to `Actual Budget`.
- `ACTUAL_PASSKEY_EXTRA_ORIGINS`: optional, comma separated. Additional origins that are allowed to complete a passkey ceremony, such as a native mobile app. Most people will not need this.
- `ACTUAL_PASSKEY_ENFORCE`: set to `true` to hide every other login method once passkeys are working. Leave it unset until you have signed in with a passkey successfully.

The same settings can go in `config.json` under a `passkey` key, using `server_hostname`, `rpName`, `extraOrigins` and `enforce`.

:::warning
Do not change `ACTUAL_PASSKEY_SERVER_HOSTNAME` once people have created passkeys. Passkeys are tied to that hostname, and a new one makes every existing passkey unusable. If you must move the server, plan to re-enrol everyone, and keep the server password available in the meantime.
:::

## Session Length

`ACTUAL_TOKEN_EXPIRATION` applies to passkey sessions as it does to password sessions: `never` (the default) or a number of seconds. The `openid-provider` value has no meaning for passkeys and is treated as `never`.

## Which Devices Can Use Passkeys

Passkeys work in current versions of Firefox, Chrome, Edge and Safari, on phones and desktops, whenever the site is served over `https://`.

They do not work inside every app that embeds a web view. In particular, an Android app that embeds a browser engine cannot create or use passkeys for a website unless Android recognises it as a browser, so a custom wrapper app will fail where Firefox for Android on the same phone succeeds.
